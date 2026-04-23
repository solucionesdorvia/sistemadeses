import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { getLibreOfficeCommand } from "@/lib/libreoffice/command";

const execFileAsync = promisify(execFile);

function safeXlsxName(fileName: string): string {
  const base = basename(fileName);
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const n = cleaned.length > 0 && cleaned.length <= 200 ? cleaned : "workbook.xlsx";
  return n.toLowerCase().endsWith(".xlsx") ? n : `${n}.xlsx`;
}

/**
 * XLSX → PDF con LibreOffice (headless), sin servicios de terceros de pago.
 * En Railway: la imagen Docker ya instala soffice.
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
  const sourcePath = join(tempRoot, localName);
  const outDir = tempRoot;
  const profileDir = join(tempRoot, "lo-profile");
  const userInstallation = pathToFileURL(profileDir).href;
  const stem = basename(sourcePath, extname(sourcePath)) || "workbook";
  const expectedPdf = join(outDir, `${stem}.pdf`);

  try {
    await writeFile(sourcePath, xlsx);

    // `pdf:calc_pdf_Export` aplica a hojas de cálculo; `pdf` genérico a veces falla con .xlsx.
    await execFileAsync(
      loCommand,
      [
        "--headless",
        "--norestore",
        "--nologo",
        "--nofirststartwizard",
        `-env:UserInstallation=${userInstallation}`,
        "--convert-to",
        "pdf:calc_pdf_Export",
        "--outdir",
        outDir,
        sourcePath,
      ],
      {
        env: {
          ...process.env,
          HOME: tempRoot,
          SAL_USE_VCLPLUGIN: "headless",
          LANG: process.env.LANG ?? "C.UTF-8",
        },
        timeout: 120_000,
        maxBuffer: 50 * 1024 * 1024,
      },
    );

    try {
      return await readFile(expectedPdf);
    } catch {
      const files = (await readdir(outDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf"))
        .map((e) => e.name);
      if (files.length === 0) {
        throw new Error("LibreOffice no genero ningun PDF.");
      }
      const name =
        files.find((f) => f.toLowerCase() === `${stem}.pdf`.toLowerCase()) ?? files[0];
      return readFile(join(outDir, name));
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("LibreOffice ")) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : "error desconocido";
    throw new Error(`LibreOffice (cuentas PDF): ${msg}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
