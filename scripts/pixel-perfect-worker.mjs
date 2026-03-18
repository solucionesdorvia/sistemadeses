#!/usr/bin/env node

import { config as loadEnv } from "dotenv";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dns from "node:dns";
import { resolve4 } from "node:dns/promises";

import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);

loadEnv({ path: ".env.local" });

const args = parseArgs(process.argv.slice(2));
const companyFilter = args.company ?? null;
const force = args.force ?? false;
const maxFiles = args.max ?? Number.POSITIVE_INFINITY;
const inputPath = args.input ?? null;
const outputDir = args.outputDir ?? null;

await ensureCommand("soffice");
await ensureCommand("sips");

if (inputPath) {
  await runLocalMode(inputPath, outputDir);
  process.exit(0);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local");
  process.exit(1);
}

await ensureDnsResolution(SUPABASE_URL);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = await resolveUserId(supabase, args.userId ?? null);
console.log(`Usando user_id: ${userId}`);

const basePath = `${userId}/vendedores`;
const folders = await listAll(supabase, "results", basePath);
let processed = 0;
let skipped = 0;
let failed = 0;
let touched = 0;

for (const folder of folders) {
  const folderPath = `${basePath}/${folder.name}`;
  const files = await listAll(supabase, "results", folderPath);
  const targets = files
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".xlsx"))
    .filter((name) => !name.endsWith("_pixel.xlsx"))
    .filter((name) => !name.endsWith("_pixel.pdf"))
    .filter((name) => {
      if (!companyFilter) return true;
      return name.includes(`_${companyFilter}.xlsx`);
    });

  for (const fileName of targets) {
    if (touched >= maxFiles) break;
    const sourcePath = `${folderPath}/${fileName}`;
    const pixelPdfPath = sourcePath.replace(/\.xlsx$/i, "_pixel.pdf");
    const pixelXlsxPath = sourcePath.replace(/\.xlsx$/i, "_pixel.xlsx");

    if (!force) {
      const existing = await listAll(supabase, "results", folderPath);
      const names = new Set(existing.map((entry) => entry.name));
      const pixelPdfName = basename(pixelPdfPath);
      const pixelXlsxName = basename(pixelXlsxPath);
      if (names.has(pixelPdfName) && names.has(pixelXlsxName)) {
        skipped += 1;
        continue;
      }
    }

    try {
      console.log(`Procesando ${sourcePath}`);
      const sourceBuffer = await downloadStorageFile(supabase, "results", sourcePath);
      const tempRoot = await mkdtemp(join(tmpdir(), "pixel-worker-"));
      const localXlsx = join(tempRoot, fileName);
      const localPdf = join(tempRoot, fileName.replace(/\.xlsx$/i, ".pdf"));
      const localPng = join(tempRoot, fileName.replace(/\.xlsx$/i, ".png"));

      await writeFile(localXlsx, sourceBuffer);
      await convertXlsxToPdf(localXlsx, tempRoot);
      await convertPdfToPng(localPdf, localPng);
      const pngBuffer = await readFile(localPng);
      const pixelWorkbook = await buildImageWorkbook(pngBuffer);
      const pdfBuffer = await readFile(localPdf);

      await uploadStorageFile(supabase, "results", pixelPdfPath, pdfBuffer, "application/pdf");
      await uploadStorageFile(
        supabase,
        "results",
        pixelXlsxPath,
        pixelWorkbook,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );

      await rm(tempRoot, { recursive: true, force: true });
      processed += 1;
      touched += 1;
    } catch (error) {
      failed += 1;
      touched += 1;
      console.error(
        `Error en ${sourcePath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (touched >= maxFiles) break;
}

console.log(JSON.stringify({ processed, skipped, failed }, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--user-id") parsed.userId = argv[i + 1];
    if (token === "--company") parsed.company = argv[i + 1];
    if (token === "--max") parsed.max = Number(argv[i + 1]);
    if (token === "--input") parsed.input = argv[i + 1];
    if (token === "--output-dir") parsed.outputDir = argv[i + 1];
    if (token === "--force") parsed.force = true;
  }
  return parsed;
}

async function resolveUserId(client, explicitUserId) {
  if (explicitUserId) return explicitUserId;
  const { data, error } = await withRetry(() =>
    client.from("vendors").select("user_id")
  );
  if (error) throw error;
  const ids = [...new Set((data ?? []).map((row) => row.user_id).filter(Boolean))];
  if (ids.length === 0) throw new Error("No se encontraron user_id en vendors.");
  if (ids.length > 1) {
    throw new Error("Hay multiples user_id. Ejecuta con --user-id <uuid>.");
  }
  return ids[0];
}

async function ensureCommand(command) {
  try {
    await execFileAsync("which", [command]);
  } catch {
    throw new Error(`No se encontro '${command}'. Instalala y reintenta.`);
  }
}

async function listAll(client, bucket, path) {
  const all = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const { data, error } = await withRetry(() =>
      client.storage.from(bucket).list(path, { limit, offset })
    );
    if (error) throw error;
    const page = data ?? [];
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

async function downloadStorageFile(client, bucket, path) {
  const { data, error } = await withRetry(() =>
    client.storage.from(bucket).download(path)
  );
  if (error || !data) throw error ?? new Error("No se pudo descargar.");
  return new Uint8Array(await data.arrayBuffer());
}

async function uploadStorageFile(client, bucket, path, bytes, contentType) {
  const { error } = await withRetry(() =>
    client.storage.from(bucket).upload(path, bytes, {
      upsert: true,
      contentType,
    })
  );
  if (error) throw error;
}

async function convertXlsxToPdf(localXlsx, outDir) {
  await execFileAsync("soffice", [
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    outDir,
    localXlsx,
  ]);
}

async function convertPdfToPng(localPdf, localPng) {
  await execFileAsync("sips", ["-s", "format", "png", localPdf, "--out", localPng]);
}

async function buildImageWorkbook(pngBuffer) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Vista_fiel");
  const imageId = workbook.addImage({ buffer: pngBuffer, extension: "png" });
  const { width, height } = readPngDimensions(pngBuffer);

  sheet.addImage(imageId, {
    tl: { col: 0, row: 0 },
    ext: { width, height },
  });
  sheet.views = [{ state: "normal", zoomScale: 100 }];

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function readPngDimensions(pngBytes) {
  if (pngBytes.length < 24) return { width: 1280, height: 720 };
  const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (!width || !height) return { width: 1280, height: 720 };
  return { width, height };
}

async function runLocalMode(inputFilePath, maybeOutputDir) {
  const inputBytes = await readFile(inputFilePath);
  const tempRoot = await mkdtemp(join(tmpdir(), "pixel-local-"));
  const inputName = basename(inputFilePath);
  const localXlsx = join(tempRoot, inputName);
  const localPdf = join(tempRoot, inputName.replace(/\.xlsx$/i, ".pdf"));
  const localPng = join(tempRoot, inputName.replace(/\.xlsx$/i, ".png"));

  await writeFile(localXlsx, inputBytes);
  await convertXlsxToPdf(localXlsx, tempRoot);
  await convertPdfToPng(localPdf, localPng);

  const pngBuffer = await readFile(localPng);
  const pixelWorkbook = await buildImageWorkbook(pngBuffer);
  const pdfBuffer = await readFile(localPdf);

  const outputRoot = maybeOutputDir ?? process.cwd();
  const baseNoExt = inputName.replace(/\.xlsx$/i, "");
  const pixelXlsxOut = join(outputRoot, `${baseNoExt}_pixel.xlsx`);
  const pixelPdfOut = join(outputRoot, `${baseNoExt}_pixel.pdf`);

  await writeFile(pixelXlsxOut, pixelWorkbook);
  await writeFile(pixelPdfOut, pdfBuffer);
  await rm(tempRoot, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        mode: "local",
        input: inputFilePath,
        output_pixel_xlsx: pixelXlsxOut,
        output_pixel_pdf: pixelPdfOut,
      },
      null,
      2,
    ),
  );
}

async function ensureDnsResolution(supabaseUrl) {
  const host = new URL(supabaseUrl).hostname;
  try {
    await resolve4(host);
    return;
  } catch {
    // Fallback para entornos donde el DNS local falla con ENOTFOUND.
    dns.setServers(["1.1.1.1", "8.8.8.8"]);
    await resolve4(host);
    console.log(`DNS fallback activo para ${host} (1.1.1.1 / 8.8.8.8).`);
  }
}

async function withRetry(fn, retries = 4) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const message = error instanceof Error ? error.message : String(error);
      const retriable =
        /ENOTFOUND|EAI_AGAIN|fetch failed|ECONNRESET|ETIMEDOUT|timeout/i.test(message);
      if (!retriable || attempt > retries) {
        throw error;
      }
      const delayMs = Math.min(15000, 1000 * 2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
