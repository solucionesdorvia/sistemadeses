import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CANDIDATES = ["soffice", "libreoffice"] as const;

/** Evita respuesta positiva con `which` aunque el wrapper falle al ejecutar (p. ej. ruta a .app inexistente). */
let resolved: string | null | undefined;

/**
 * Comando de LibreOffice utilizable (probado con `--version`), o null si no hay ninguno.
 */
export async function getLibreOfficeCommand(): Promise<string | null> {
  if (resolved !== undefined) {
    return resolved;
  }
  for (const cmd of CANDIDATES) {
    try {
      await execFileAsync(cmd, ["--version"], {
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
      });
      resolved = cmd;
      return resolved;
    } catch {
      /* siguiente candidato */
    }
  }
  resolved = null;
  return null;
}
