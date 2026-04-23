import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { PaperSize } from "exceljs";
import ExcelJS from "exceljs";

import { getLibreOfficeCommand } from "@/lib/libreoffice/command";
import {
  minimalPdfError,
  xlsxToPdfFallback,
} from "@/lib/libreoffice/xlsxToPdfFallback";

const execFileAsync = promisify(execFile);

/**
 * Ajusta impresión: área de datos, apaisado A3, 1 pág. de ancho, alto en las que
 * haga falta. Puede dejar un OOXML raro: si el PDF no sale, reintentamos con el
 * XLSX crudo.
 */
async function applyFitSheetWidthForPrint(xlsx: Uint8Array): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(xlsx) as never);
  workbook.eachSheet((ws) => {
    if (ws.state === "veryHidden") return;
    const d = ws.dimensions;
    if (d && d.bottom >= 1 && d.right >= 1) {
      ws.pageSetup.printArea = `${d.tl}:${d.br}`;
    }
    const ps = ws.pageSetup;
    if (ps.scale != null) {
      (ps as { scale?: number }).scale = undefined;
    }
    ps.fitToPage = true;
    ps.paperSize = 8 as PaperSize;
    ps.orientation = "landscape";
    (ps as { usePrinterDefaults?: boolean }).usePrinterDefaults = false;
    ps.fitToWidth = 1;
    ps.fitToHeight = 0;
    ps.margins = {
      left: 0.3,
      right: 0.3,
      top: 0.35,
      bottom: 0.35,
      header: 0.2,
      footer: 0.2,
    };
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function safeXlsxName(fileName: string): string {
  const base = basename(fileName);
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const n = cleaned.length > 0 && cleaned.length <= 200 ? cleaned : "workbook.xlsx";
  return n.toLowerCase().endsWith(".xlsx") ? n : `${n}.xlsx`;
}

async function findPdfPath(
  outDir: string,
  stem: string,
): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(outDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf"))
      .map((e) => e.name);
  } catch {
    return null;
  }
  if (names.length === 0) {
    return null;
  }
  const exact = names.find((f) => f.toLowerCase() === `${stem}.pdf`.toLowerCase());
  const pick = exact ?? names[0]!;
  return join(outDir, pick);
}


/**
 * XLSX → PDF con LibreOffice (headless), sin terceros de pago.
 * Estrategia: primero el archivo original (máxima compat.); luego ajuste de hoja
 * (apaisado/ancho) con ExcelJS; nunca depender del flujo ods.
 */
export async function convertXlsxToPdfWithLibreOffice(
  xlsx: Uint8Array,
  fileName: string,
): Promise<Buffer> {
  const loCommand = await getLibreOfficeCommand();
  if (!loCommand) {
    throw new Error(
      "LibreOffice no esta disponible (soffice / libreoffice en PATH). En local: instalar LibreOffice; en produccion: usar la imagen Docker con LO.",
    );
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "xlsx-pdf-lo-"));
  const localName = safeXlsxName(fileName);
  const sourcePath = resolve(tempRoot, localName);
  const outDir = resolve(tempRoot);
  const profileDir = join(tempRoot, "lo-profile");
  const userInstallation = pathToFileURL(profileDir).href;
  const stem = basename(sourcePath, extname(sourcePath)) || "workbook";

  const loEnv = {
    ...process.env,
    HOME: tempRoot,
    SAL_USE_VCLPLUGIN: "headless",
    LANG: process.env.LANG ?? "C.UTF-8",
    OOGM_NO_NFS_CHECK: "1",
  };

  const runLoPdf = async (input: string, filter: string) => {
    const args = [
      "--headless",
      "--norestore",
      "--nologo",
      "--nofirststartwizard",
      `-env:UserInstallation=${userInstallation}`,
      "--convert-to",
      filter,
      "--outdir",
      outDir,
      input,
    ];
    let stderr = "";
    try {
      const r = await execFileAsync(loCommand, args, {
        env: loEnv,
        cwd: outDir,
        timeout: 120_000,
        maxBuffer: 50 * 1024 * 1024,
      });
      stderr = (r.stderr as string | undefined)?.trim() ?? "";
      return { stderr };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      stderr = [e.stderr, e.message].filter(Boolean).join(" ").trim();
      return { stderr };
    }
  };

  const attempts: string[] = [];

  try {
    const runSeries = async (buffer: Buffer, label: string) => {
      await writeFile(sourcePath, buffer);
      const filters = ["pdf:calc_pdf_Export", "pdf"] as const;
      for (const f of filters) {
        const r = await runLoPdf(sourcePath, f);
        if (r.stderr) {
          attempts.push(`[${label} ${f}] ${r.stderr.slice(0, 400)}`);
        }
        const p = await findPdfPath(outDir, stem);
        if (p) {
          const b = await readFile(p);
          if (b.length > 0) {
            return b;
          }
        }
      }
      return null;
    };

    // 1) XLSX original: LO suele abrirlo como Excel generó; evita un OOXML
    //   roto por ExcelJS.
    let out = await runSeries(Buffer.from(xlsx), "original");
    if (out) {
      return out;
    }

    // 2) Con ajuste de hoja (apaisado, área, etc.)
    let patched: Buffer | null = null;
    try {
      patched = await applyFitSheetWidthForPrint(xlsx);
    } catch {
      patched = null;
    }
    if (patched) {
      out = await runSeries(patched, "ajustado");
      if (out) {
        return out;
      }
    }

    // 3) Nombre fijo in.xlsx (evita paths raros en algunos entornos)
    const altPath = resolve(outDir, "in.xlsx");
    for (const buf of [Buffer.from(xlsx), patched].filter(
      (b): b is Buffer => b != null,
    )) {
      await writeFile(altPath, buf);
      for (const f of ["pdf:calc_pdf_Export", "pdf"] as const) {
        const r = await runLoPdf(altPath, f);
        if (r.stderr) {
          attempts.push(`[in.xlsx ${f}] ${r.stderr.slice(0, 400)}`);
        }
        const p = await findPdfPath(outDir, "in");
        if (p) {
          const b = await readFile(p);
          if (b.length > 0) {
            return b;
          }
        }
      }
    }

    let list = "";
    try {
      const all = await readdir(outDir);
      list = all.slice(0, 30).join(", ");
    } catch {
      list = "(no se pudo listar el directorio)";
    }

    const log = attempts.length
      ? ` LO: ${attempts.join(" | ").slice(0, 1000)}`
      : "";
    throw new Error(
      `LibreOffice no genero PDF (archivos en temp: [${list}]).${log}`,
    );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("LibreOffice ")) {
      throw e;
    }
    if (e instanceof Error && e.message.startsWith("LibreOffice no genero")) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : "error desconocido";
    throw new Error(`LibreOffice (cuentas PDF): ${msg}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Prioridad: LibreOffice (fidelidad). Si no hay soffice o falla, PDF de
 * respaldo con pdf-lib (tabla de datos) — **siempre** devuelve un PDF
 * mientras el XLSX se pueda leer.
 */
export async function convertXlsxToPdf(
  xlsx: Uint8Array,
  fileName: string,
): Promise<Buffer> {
  try {
    const withFallback = async (errNote: string) => {
      try {
        return await xlsxToPdfFallback(xlsx, fileName, errNote);
      } catch (e) {
        const m = [errNote, e instanceof Error ? e.message : String(e)]
          .filter(Boolean)
          .join(" | ");
        return minimalPdfError(m);
      }
    };

    const lo = await getLibreOfficeCommand();
    if (lo) {
      try {
        return await convertXlsxToPdfWithLibreOffice(xlsx, fileName);
      } catch (err) {
        const note = err instanceof Error ? err.message : String(err);
        return withFallback(note);
      }
    }
    return withFallback(
      "LibreOffice (soffice) no esta en el PATH. PDF generado solo desde datos de la hoja.",
    );
  } catch (e) {
    return minimalPdfError(e instanceof Error ? e.message : String(e));
  }
}
