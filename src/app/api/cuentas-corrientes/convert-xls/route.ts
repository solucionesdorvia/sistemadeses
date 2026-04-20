import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import * as XLSX from "xlsx";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return Response.json({ message: "Archivo .xls faltante." }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith(".xls")) {
      return Response.json({ message: "Solo se acepta .xls en este endpoint." }, { status: 400 });
    }

    const sourceName = basename(file.name);
    const targetName = sourceName.replace(/\.xls$/i, ".xlsx");
    const sourceBytes = new Uint8Array(await file.arrayBuffer());

    const converted =
      (await convertWithLibreOffice(sourceBytes, sourceName)) ?? convertWithSheetJS(sourceBytes);

    return new Response(new Uint8Array(converted), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Converted-Filename": targetName,
      },
    });
  } catch (error) {
    return Response.json(
      { message: error instanceof Error ? error.message : "No se pudo convertir .xls." },
      { status: 500 },
    );
  }
}

async function hasSoffice() {
  try {
    await execFileAsync("which", ["soffice"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * LibreOffice preserva formato, anchos y estilos al pasar .xls → .xlsx (mejor para PDF posterior).
 * Si falla (p. ej. sin JRE), se usa SheetJS en el caller.
 */
async function convertWithLibreOffice(
  sourceBytes: Uint8Array,
  sourceName: string,
): Promise<Buffer | null> {
  if (!(await hasSoffice())) return null;

  const tempRoot = await mkdtemp(join(tmpdir(), "convert-xls-lo-"));
  const sourcePath = join(tempRoot, sourceName);
  const targetName = sourceName.replace(/\.xls$/i, ".xlsx");
  const targetPath = join(tempRoot, targetName);
  const profileDir = join(tempRoot, "lo-profile");
  const userInstallation = pathToFileURL(profileDir).href;

  try {
    await writeFile(sourcePath, sourceBytes);

    await execFileAsync(
      "soffice",
      [
        "--headless",
        "--norestore",
        "--nologo",
        "--nofirststartwizard",
        `-env:UserInstallation=${userInstallation}`,
        "--convert-to",
        "xlsx",
        "--outdir",
        tempRoot,
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

    return await readFile(targetPath);
  } catch {
    return null;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function convertWithSheetJS(sourceBytes: Uint8Array): Buffer {
  const workbook = XLSX.read(sourceBytes, {
    type: "array",
    cellDates: true,
  });

  if (!workbook.SheetNames?.length) {
    throw new Error("El archivo .xls no contiene hojas legibles.");
  }

  return XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer",
  }) as Buffer;
}
