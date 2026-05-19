import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { getLibreOfficeCommand } from "@/lib/libreoffice/command";
import { patchXlsxForPdfFit } from "@/lib/libreoffice/patchXlsxForPdfFit";
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

  // Pre-crear el perfil de LibreOffice con Java desactivado en su propio
  // registro de configuración. Esto evita que LO inicialice la JVM incluso
  // cuando Java está instalado en el sistema — más fiable que --nojava solo,
  // que sólo aplica después de que el perfil ya fue cargado.
  const loUserDir = join(profileDir, "user");
  await mkdir(loUserDir, { recursive: true });
  await writeFile(
    join(loUserDir, "registrymodifications.xcu"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<oor:items xmlns:oor="http://openoffice.org/2001/registry"',
      '           xmlns:xs="http://www.w3.org/2001/XMLSchema"',
      '           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
      '  <item oor:path="/org.openoffice.Office.Java/Java">',
      '    <prop oor:name="Enable" oor:op="fuse"><value>false</value></prop>',
      "  </item>",
      "</oor:items>",
    ].join("\n"),
    "utf-8",
  );

  const loEnv = {
    ...process.env,
    HOME: tempRoot,
    SAL_USE_VCLPLUGIN: "headless",
    LANG: process.env.LANG ?? "C.UTF-8",
    OOGM_NO_NFS_CHECK: "1",
    // SAL_NO_JAVA=1 es la variable de entorno interna de LibreOffice para
    // deshabilitar Java ANTES de que el runtime cargue la JVM — más
    // efectivo que --nojava, que solo aplica después de parsear el perfil.
    SAL_NO_JAVA: "1",
    // JAVA_HOME a ruta inexistente impide que LibreOffice localice la JVM.
    JAVA_HOME: "/dev/null/no-java",
    JDK_JAVA_OPTIONS: "",
    _JAVA_OPTIONS: "",
  };

  const argsFor = (filter: string) => [
    "--headless",
    "--norestore",
    "--nologo",
    "--nofirststartwizard",
    "--nojava",
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

  // Dos pasadas: (1) XLSX parchado (apaisado A3 + fitToWidth=1) con filtro
  // `pdf:calc_pdf_Export`. (2) XLSX original sin parchar con filtro `pdf` —
  // red de seguridad para los XLSX en los que el parche genera XML que LO
  // rechaza (caso Days observado: caia al fallback de pdf-lib que trunca).
  let patched: Buffer;
  try {
    patched = await patchXlsxForPdfFit(xlsx);
  } catch {
    patched = Buffer.from(xlsx);
  }
  const original = Buffer.from(xlsx);

  const passes: Array<{ input: Buffer; filter: "pdf:calc_pdf_Export" | "pdf" }> = [
    { input: patched, filter: "pdf:calc_pdf_Export" },
    { input: original, filter: "pdf" },
  ];

  let lastErrorMessage = "";
  try {
    for (const pass of passes) {
      await writeFile(inPath, pass.input);
      try {
        await execFileAsync(loCommand, argsFor(pass.filter), {
          env: loEnv,
          cwd: outDir,
          timeout: 120_000,
          maxBuffer: 20 * 1024 * 1024,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Loguear COMPLETO en consola (Railway logs) — sin truncar — para
        // diagnosticar por qué LibreOffice rechaza un XLSX puntual.
        console.error(
          `[convertXlsxToPdfWithLibreOffice] pasada filter=${pass.filter} input=${pass.input === patched ? "patched" : "original"} bytes=${pass.input.byteLength} fallo:`,
          msg,
        );
        if (/cannot fork|ENOMEM|out of memory/i.test(msg)) {
          throw new Error(
            `LibreOffice: recurso agotado en el servidor (Cannot fork / memoria). Usar un plan con mas RAM o el PDF de respaldo se aplicara. ${msg}`,
          );
        }
        lastErrorMessage = `filter=${pass.filter} input=${pass.input === patched ? "patched" : "original"}: ${msg}`;
        // No tirar: seguir a la pasada siguiente (XLSX original sin parchar).
        continue;
      }

      // Si la JVM crasheó (hs_err_pid*.log en el directorio de trabajo),
      // LibreOffice no va a recuperarse: saltar al fallback sin reintentar.
      const dirEntries = await readdir(outDir);
      const jvmCrash = dirEntries.some((f) => /^hs_err_pid\d+\.log$/i.test(f));
      if (jvmCrash) {
        throw new Error(
          `LibreOffice: la JVM crasheo (${dirEntries.filter((f) => /^hs_err_pid/.test(f)).join(", ")}). Usar PDF de respaldo.`,
        );
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
    const tail = lastErrorMessage ? ` ultimo_error=${lastErrorMessage}` : "";
    throw new Error(
      `LibreOffice no genero ${LO_STEM}.pdf en [${list || "directorio vacio"}].${tail}`,
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
