import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

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

    const hasBinary = await hasSoffice();
    if (!hasBinary) {
      return Response.json(
        { message: "LibreOffice (soffice) no disponible para convertir .xls." },
        { status: 500 },
      );
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "convert-xls-"));
    const sourceName = basename(file.name);
    const sourcePath = join(tempRoot, sourceName);
    const targetName = sourceName.replace(/\.xls$/i, ".xlsx");
    const targetPath = join(tempRoot, targetName);

    try {
      const sourceBytes = new Uint8Array(await file.arrayBuffer());
      await writeFile(sourcePath, sourceBytes);

      await execFileAsync("soffice", [
        "--headless",
        "--convert-to",
        "xlsx",
        "--outdir",
        tempRoot,
        sourcePath,
      ]);

      const converted = await readFile(targetPath);
      return new Response(converted, {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "X-Converted-Filename": targetName,
        },
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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
