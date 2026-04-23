import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { getLibreOfficeCommand } from "@/lib/libreoffice/command";
import {
  minimalPdfError,
  xlsxToPdfFallback,
} from "@/lib/libreoffice/xlsxToPdfFallback";

const execFileAsync = promisify(execFile);

/**
 * Mismo `stem` que el .xlsx de entrada: LO escribe {stem}.pdf en --outdir.
 */
const LO_INPUT = "in.xlsx";
const LO_STEM = "in";

/**
 * Máx. 2 arranques de LibreOffice por archivo (en Railway/servidores chicos, más
 * intentos → "Cannot fork" / OOM: el resto se resuelve con xlsxToPdfFallback).
 */
export async function convertXlsxToPdfWithLibreOffice(
  xlsx: Uint8Array,
  _fileName: string,
): Promise<Buffer> {
  const loCommand = await getLibreOfficeCommand();
  if (!loCommand) {
    throw new Error(
      "LibreOffice no esta disponible (soffice / libreoffice en PATH). En local: instalar LibreOffice; en produccion: usar la imagen Docker con LO.",
    );
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "xlsx-pdf-lo-"));
  const inPath = resolve(tempRoot, LO_INPUT);
  const outDir = resolve(tempRoot);
  const profileDir = join(tempRoot, "lo-profile");
  const userInstallation = pathToFileURL(profileDir).href;

  const loEnv = {
    ...process.env,
    HOME: tempRoot,
    SAL_USE_VCLPLUGIN: "headless",
    LANG: process.env.LANG ?? "C.UTF-8",
    OOGM_NO_NFS_CHECK: "1",
  };

  const argsFor = (filter: string) => [
    "--headless",
    "--norestore",
    "--nologo",
    "--nofirststartwizard",
    `-env:UserInstallation=${userInstallation}`,
    "--convert-to",
    filter,
    "--outdir",
    outDir,
    inPath,
  ];

  const findPdf = async () => {
    const names = (await readdir(outDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf"))
      .map((e) => e.name);
    if (names.length === 0) {
      return null;
    }
    const exact = names.find((f) => f.toLowerCase() === `${LO_STEM}.pdf`.toLowerCase());
    return join(outDir, exact ?? names[0]!);
  };

  try {
    await writeFile(inPath, Buffer.from(xlsx));

    for (const filter of ["pdf:calc_pdf_Export", "pdf"] as const) {
      try {
        await execFileAsync(loCommand, argsFor(filter), {
          env: loEnv,
          cwd: outDir,
          timeout: 120_000,
          maxBuffer: 20 * 1024 * 1024,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/cannot fork|ENOMEM|out of memory/i.test(msg)) {
          throw new Error(
            `LibreOffice: recurso agotado en el servidor (Cannot fork / memoria). Usar un plan con mas RAM o el PDF de respaldo se aplicara. ${msg}`,
          );
        }
        throw e;
      }

      const p = await findPdf();
      if (p) {
        const b = await readFile(p);
        if (b.length > 0) {
          return b;
        }
      }
    }

    let list = "";
    try {
      const all = await readdir(outDir);
      list = all.slice(0, 20).join(", ");
    } catch {
      list = "";
    }
    throw new Error(
      `LibreOffice no genero ${LO_STEM}.pdf en [${list || "directorio vacio"}].`,
    );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("LibreOffice ")) {
      throw e;
    }
    if (e instanceof Error && e.message.startsWith("LibreOffice no genero")) {
      throw e;
    }
    if (e instanceof Error && e.message.startsWith("LibreOffice:")) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : "error desconocido";
    throw new Error(`LibreOffice (cuentas PDF): ${msg}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Prioridad: LibreOffice (1–2 forks como máx.). Si no hay o falla, PDF de
 * respaldo (pdf-lib) — no encadena mas procesos.
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
