import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createClient as createAdminClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

import { getClientEnv, getServerEnv } from "@/lib/config/env";
import { createClient } from "@/lib/supabase/server";

const execFileAsync = promisify(execFile);

/** A2 apaisado en puntos PDF (~594×420 mm). Más ancho útil que A3 para cuentas anchas. */
const DESES_PDF_PAGE_W = 1684;
const DESES_PDF_PAGE_H = 1191;

export const runtime = "nodejs";

type Body = {
  companyType?: "americana" | "days" | "desesplast";
  vendorName?: string;
};

export async function POST(request: Request) {
  try {
    const sofficeAvailable = await hasSoffice();
    if (!sofficeAvailable) {
      return Response.json({
        ok: false,
        converted: 0,
        errors: [],
        message: "LibreOffice (soffice) no disponible en runtime.",
      });
    }

    const authClient = await createClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return Response.json({ message: "Sesion invalida." }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as Body;
    const { NEXT_PUBLIC_SUPABASE_URL } = getClientEnv();
    const serverEnv = getServerEnv();
    const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv;
    const forceLandscapePdf = isTruthyEnvFlag(serverEnv.CONVERT_PDF_FORCE_LANDSCAPE_FIT);
    const printScalePercent = parsePrintScalePercent(serverEnv.CONVERT_PDF_PRINT_SCALE);
    const desesPrintScalePercent = parseDesesPrintScalePercent(serverEnv.CONVERT_PDF_DESES_PRINT_SCALE);

    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return Response.json(
        { message: "SUPABASE_SERVICE_ROLE_KEY no configurado." },
        { status: 500 },
      );
    }

    const admin = createAdminClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const vendorsResult = await admin
      .from("vendors")
      .select("normalized_name,canonical_name,convert_to_pdf")
      .eq("user_id", user.id);

    if (vendorsResult.error) {
      return Response.json({ message: vendorsResult.error.message }, { status: 500 });
    }

    let converted = 0;
    const errors: Array<{ vendor: string; file: string; reason: string }> = [];
    const companySuffix = body.companyType ? `_${body.companyType}.xlsx` : ".xlsx";

    const normalizedTarget = body.vendorName?.trim().toLowerCase() ?? null;
    const selectedVendors = (vendorsResult.data ?? []).filter((vendor) => {
      const matchesByName = normalizedTarget
        ? vendor.normalized_name.toLowerCase() === normalizedTarget ||
          (vendor.canonical_name ?? "").toLowerCase() === normalizedTarget
        : true;
      if (!matchesByName) return false;

      // Global conversion only for vendors with the PDF flag enabled.
      // If a specific vendor is requested, allow on-demand conversion.
      return normalizedTarget ? true : Boolean(vendor.convert_to_pdf);
    });

    for (const vendor of selectedVendors) {
      const displayName = vendor.canonical_name ?? vendor.normalized_name;
      const safeFolder = pathSafeVendorName(displayName);
      const baseFolder = `${user.id}/vendedores/${safeFolder}`;

      const listed = await admin.storage.from("results").list(baseFolder, { limit: 1000 });
      if (listed.error) {
        errors.push({
          vendor: displayName,
          file: baseFolder,
          reason: listed.error.message,
        });
        continue;
      }

      const targets = (listed.data ?? []).filter((file) => {
        return body.companyType ? file.name.endsWith(companySuffix) : file.name.endsWith(".xlsx");
      });

      for (const file of targets) {
        const filePath = `${baseFolder}/${file.name}`;
        try {
          const downloaded = await admin.storage.from("results").download(filePath);
          if (downloaded.error || !downloaded.data) {
            throw new Error(downloaded.error?.message ?? "No se pudo descargar XLSX.");
          }

          const sourceBytes = new Uint8Array(await downloaded.data.arrayBuffer());
          const tempRoot = await mkdtemp(join(tmpdir(), "cc-pdf-"));
          const localXlsx = join(tempRoot, basename(file.name));
          const localPdf = join(tempRoot, basename(file.name).replace(/\.xlsx$/i, ".pdf"));

          try {
            const xlsxForPdf = await buildXlsxBytesForPdf({
              sourceBytes,
              fileName: file.name,
              requestCompanyType: body.companyType,
              forceLandscapePdf,
              printScalePercent,
              desesPrintScalePercent,
            });
            await writeFile(localXlsx, xlsxForPdf);
            await runLibreOfficePdfConversion(localXlsx, tempRoot);
            let pdfBytes: Buffer;
            try {
              pdfBytes = Buffer.from(await readFile(localPdf));
            } catch (err) {
              const code =
                err && typeof err === "object" && "code" in err
                  ? String((err as NodeJS.ErrnoException).code)
                  : "";
              throw new Error(
                code === "ENOENT"
                  ? "LibreOffice no genero el PDF (archivo .pdf ausente tras la conversion)."
                  : err instanceof Error
                    ? err.message
                    : "No se pudo leer el PDF generado.",
              );
            }

            const desesPdfPostFit =
              isDesesplastResultsXlsx(file.name) || body.companyType === "desesplast";
            if (desesPdfPostFit) {
              const rawPdf = Buffer.from(pdfBytes);
              try {
                if (await hasPdftoppm()) {
                  pdfBytes = await fitDesesPdfRasterToDesesPage(localPdf, tempRoot);
                } else {
                  throw new Error("sin pdftoppm");
                }
              } catch {
                try {
                  if (await hasGhostscript()) {
                    pdfBytes = await fitDesesPdfViaPsThenPdf(localPdf, tempRoot);
                  } else {
                    throw new Error("sin ghostscript");
                  }
                } catch {
                  try {
                    pdfBytes = await fitDesesPdfPagesToDesesPage(rawPdf);
                  } catch {
                    if (await hasGhostscript()) {
                      try {
                        pdfBytes = await fitPdfToDesesPageWithGhostscript(localPdf, tempRoot);
                      } catch {
                        pdfBytes = rawPdf;
                      }
                    } else {
                      pdfBytes = rawPdf;
                    }
                  }
                }
              }
            }

            const pdfPath = filePath.replace(/\.xlsx$/i, ".pdf");
            const uploaded = await admin.storage.from("results").upload(pdfPath, pdfBytes, {
              upsert: true,
              contentType: "application/pdf",
            });
            if (uploaded.error) {
              throw new Error(uploaded.error.message);
            }
            converted += 1;
          } finally {
            await rm(tempRoot, { recursive: true, force: true });
          }
        } catch (error) {
          errors.push({
            vendor: displayName,
            file: file.name,
            reason: error instanceof Error ? error.message : "Error al convertir.",
          });
        }
      }
    }

    return Response.json({
      ok: true,
      converted,
      errors,
    });
  } catch (error) {
    return Response.json(
      { message: error instanceof Error ? error.message : "Error inesperado." },
      { status: 500 },
    );
  }
}

function pathSafeVendorName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

async function hasSoffice() {
  try {
    await execFileAsync("which", ["soffice"]);
    return true;
  } catch {
    return false;
  }
}

async function hasGhostscript() {
  try {
    await execFileAsync("which", ["gs"]);
    return true;
  } catch {
    return false;
  }
}

async function hasPdftoppm() {
  try {
    await execFileAsync("which", ["pdftoppm"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rasteriza cada página (Poppler) y arma un PDF con la imagen encajada en A2 apaisado.
 * Garantiza que lo que LibreOffice dibujó en cada página entre en el lienzo (texto no seleccionable).
 */
async function fitDesesPdfRasterToDesesPage(
  inputPdfPath: string,
  tempRoot: string,
): Promise<Buffer> {
  const outPrefix = join(tempRoot, "dscan");
  await execFileAsync(
    "pdftoppm",
    ["-png", "-r", "144", "-scale-to", "5600", inputPdfPath, outPrefix],
    {
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );

  const entries = await readdir(tempRoot);
  const pngNames = entries
    .filter((f) => /^dscan-\d+\.png$/i.test(f))
    .sort((a, b) => {
      const na = Number.parseInt(a.match(/(\d+)/)?.[1] ?? "0", 10);
      const nb = Number.parseInt(b.match(/(\d+)/)?.[1] ?? "0", 10);
      return na - nb;
    });

  if (pngNames.length === 0) {
    throw new Error("pdftoppm no genero PNG.");
  }

  const targetW = DESES_PDF_PAGE_W;
  const targetH = DESES_PDF_PAGE_H;
  const boxW = targetW * 0.98;
  const boxH = targetH * 0.98;
  const outPdf = await PDFDocument.create();

  for (const name of pngNames) {
    const pngBytes = await readFile(join(tempRoot, name));
    const pngImage = await outPdf.embedPng(pngBytes);
    const { width: dw, height: dh } = pngImage.scaleToFit(boxW, boxH);
    const page = outPdf.addPage([targetW, targetH]);
    page.drawImage(pngImage, {
      x: (targetW - dw) / 2,
      y: (targetH - dh) / 2,
      width: dw,
      height: dh,
    });
  }

  return Buffer.from(await outPdf.save());
}

/** PDF → PS → PDF con PDFFitPage (suele aplicar mejor a PS). */
async function fitDesesPdfViaPsThenPdf(inputPdfPath: string, tempRoot: string): Promise<Buffer> {
  const psPath = join(tempRoot, "deses-via.ps");
  const outPdf = join(tempRoot, "deses-fitted.pdf");
  await execFileAsync(
    "gs",
    [
      "-dNOPAUSE",
      "-dBATCH",
      "-dSAFER",
      "-dQUIET",
      "-sDEVICE=ps2write",
      `-sOutputFile=${psPath}`,
      inputPdfPath,
    ],
    {
      timeout: 120_000,
      maxBuffer: 80 * 1024 * 1024,
    },
  );
  await execFileAsync(
    "gs",
    [
      "-dNOPAUSE",
      "-dBATCH",
      "-dSAFER",
      "-dQUIET",
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      "-dPDFSETTINGS=/prepress",
      "-dPDFFitPage",
      "-dFIXEDMEDIA",
      `-dDEVICEWIDTHPOINTS=${DESES_PDF_PAGE_W}`,
      `-dDEVICEHEIGHTPOINTS=${DESES_PDF_PAGE_H}`,
      "-dAutoRotatePages=/None",
      `-sOutputFile=${outPdf}`,
      psPath,
    ],
    {
      timeout: 120_000,
      maxBuffer: 80 * 1024 * 1024,
    },
  );
  return Buffer.from(await readFile(outPdf));
}

/** Respaldo vectorial página a página (fudge de ancho por discrepancias de LO). */
async function fitDesesPdfPagesToDesesPage(pdfBytes: Buffer): Promise<Buffer> {
  const targetW = DESES_PDF_PAGE_W;
  const targetH = DESES_PDF_PAGE_H;
  const margin = 0.88;
  const widthFudge = 1.15;
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const n = src.getPageCount();

  for (let i = 0; i < n; i += 1) {
    const srcPage = src.getPages()[i];
    let baseW = srcPage.getWidth();
    let baseH = srcPage.getHeight();
    const rot = srcPage.getRotation().angle;
    if (rot === 90 || rot === 270) {
      const t = baseW;
      baseW = baseH;
      baseH = t;
    }

    const embedded = await out.embedPage(srcPage);
    const ew = embedded.width;
    const eh = embedded.height;
    const effW = Math.max(ew, baseW) * widthFudge;
    const effH = Math.max(eh, baseH);
    const scale = Math.min((targetW * margin) / effW, (targetH * margin) / effH);
    const drawW = ew * scale;
    const drawH = eh * scale;
    const x = (targetW - drawW) / 2;
    const y = (targetH - drawH) / 2;
    const page = out.addPage([targetW, targetH]);
    page.drawPage(embedded, {
      x,
      y,
      width: drawW,
      height: drawH,
    });
  }

  return Buffer.from(await out.save());
}

async function fitPdfToDesesPageWithGhostscript(inputPdfPath: string, tempRoot: string) {
  const outPath = join(tempRoot, "fitted-deses.pdf");
  await execFileAsync(
    "gs",
    [
      "-o",
      outPath,
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      "-dPDFSETTINGS=/prepress",
      "-dNOPAUSE",
      "-dBATCH",
      "-dSAFER",
      "-dQUIET",
      "-dPDFFitPage",
      "-dFIXEDMEDIA",
      `-dDEVICEWIDTHPOINTS=${DESES_PDF_PAGE_W}`,
      `-dDEVICEHEIGHTPOINTS=${DESES_PDF_PAGE_H}`,
      inputPdfPath,
    ],
    {
      timeout: 120_000,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  return Buffer.from(await readFile(outPath));
}

function isTruthyEnvFlag(value: string | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePrintScalePercent(raw: string | undefined) {
  if (!raw?.trim()) return 100;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return 100;
  return Math.min(400, Math.max(10, n));
}

/** Escala previa a LibreOffice para Desesplast (25-100). Más bajo = más encogido = suele entrar más ancho. */
function parseDesesPrintScalePercent(raw: string | undefined) {
  if (!raw?.trim()) return 42;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return 42;
  return Math.min(100, Math.max(25, n));
}

function isDesesplastResultsXlsx(fileName: string) {
  return fileName.toLowerCase().endsWith("_desesplast.xlsx");
}

async function buildXlsxBytesForPdf(params: {
  sourceBytes: Uint8Array;
  fileName: string;
  requestCompanyType: Body["companyType"];
  forceLandscapePdf: boolean;
  printScalePercent: number;
  desesPrintScalePercent: number;
}): Promise<Uint8Array> {
  const {
    sourceBytes,
    fileName,
    requestCompanyType,
    forceLandscapePdf,
    printScalePercent,
    desesPrintScalePercent,
  } = params;

  if (forceLandscapePdf) {
    return forceLandscapeAndFitToWidth(sourceBytes);
  }

  const isDesesplast =
    requestCompanyType === "desesplast" || isDesesplastResultsXlsx(fileName);

  if (isDesesplast) {
    return prepareDesesplastWorkbookForPdf(sourceBytes, desesPrintScalePercent);
  }

  return naturalScalePrintForPdf(sourceBytes, printScalePercent);
}

async function runLibreOfficePdfConversion(localXlsx: string, tempRoot: string) {
  const profileDir = join(tempRoot, "lo-profile");
  const userInstallation = pathToFileURL(profileDir).href;
  await execFileAsync(
    "soffice",
    [
      "--headless",
      "--norestore",
      "--nologo",
      "--nofirststartwizard",
      `-env:UserInstallation=${userInstallation}`,
      "--convert-to",
      "pdf",
      "--outdir",
      tempRoot,
      localXlsx,
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
}

/**
 * Desactiva "ajustar hoja a N paginas" (encoge todo) y usa escala % para que el PDF no salga minúsculo.
 */
async function naturalScalePrintForPdf(sourceBytes: Uint8Array, scalePercent: number) {
  try {
    const zip = await JSZip.loadAsync(sourceBytes);
    const worksheetPath = await resolveFirstWorksheetPath(zip);
    const worksheetFile = zip.file(worksheetPath);
    if (!worksheetFile) return sourceBytes;

    let xml = await worksheetFile.async("text");
    xml = ensureSheetPrNoFitToPage(xml);
    xml = ensurePageSetupNaturalScale(xml, scalePercent);

    zip.file(worksheetPath, xml);
    return await zip.generateAsync({ type: "uint8array" });
  } catch {
    return sourceBytes;
  }
}

function ensureSheetPrNoFitToPage(xml: string) {
  const pageSetUpPrRegex = /<pageSetUpPr\b[^>]*\/>/;
  if (pageSetUpPrRegex.test(xml)) {
    return xml.replace(pageSetUpPrRegex, (tag) => upsertXmlAttr(tag, "fitToPage", "0"));
  }

  const sheetPrBlockRegex = /<sheetPr\b[^>]*>([\s\S]*?)<\/sheetPr>/;
  if (sheetPrBlockRegex.test(xml)) {
    return xml.replace(sheetPrBlockRegex, (block) => {
      if (/<pageSetUpPr\b/.test(block)) {
        return block.replace(/<pageSetUpPr\b[^>]*\/>/, (tag) =>
          upsertXmlAttr(tag, "fitToPage", "0"),
        );
      }
      return block.replace("</sheetPr>", '<pageSetUpPr fitToPage="0"/></sheetPr>');
    });
  }

  return xml.replace(
    /<worksheet\b[^>]*>/,
    (tag) => `${tag}<sheetPr><pageSetUpPr fitToPage="0"/></sheetPr>`,
  );
}

function ensurePageSetupNaturalScale(xml: string, scalePercent: number) {
  const scaleStr = String(scalePercent);
  const pageSetupRegex = /<pageSetup\b[^>]*\/>/;
  if (pageSetupRegex.test(xml)) {
    return xml.replace(pageSetupRegex, (tag) => {
      let next = stripFitToPageAttrs(tag);
      next = upsertXmlAttr(next, "scale", scaleStr);
      return next;
    });
  }

  const insertion = `<pageSetup scale="${scaleStr}"/>`;
  if (xml.includes("</pageMargins>")) {
    return xml.replace("</pageMargins>", `</pageMargins>${insertion}`);
  }
  if (xml.includes("</sheetData>")) {
    return xml.replace("</sheetData>", `</sheetData>${insertion}`);
  }
  return xml.replace("</worksheet>", `${insertion}</worksheet>`);
}

function stripFitToPageAttrs(tag: string) {
  return tag
    .replace(/\s+fitToWidth="[^"]*"/gi, "")
    .replace(/\s+fitToHeight="[^"]*"/gi, "");
}

async function forceLandscapeAndFitToWidth(sourceBytes: Uint8Array) {
  try {
    const zip = await JSZip.loadAsync(sourceBytes);
    const worksheetPath = await resolveFirstWorksheetPath(zip);
    const worksheetFile = zip.file(worksheetPath);
    if (!worksheetFile) return sourceBytes;

    let xml = await worksheetFile.async("text");
    xml = ensureSheetPrFitToPage(xml);
    xml = ensureLandscapePageSetup(xml);

    zip.file(worksheetPath, xml);
    return await zip.generateAsync({ type: "uint8array" });
  } catch {
    return sourceBytes;
  }
}

async function resolveFirstWorksheetPath(zip: JSZip) {
  const workbookXml = await zip.file("xl/workbook.xml")?.async("text");
  const workbookRelsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("text");
  if (!workbookXml || !workbookRelsXml) return "xl/worksheets/sheet1.xml";

  const firstSheetMatch = workbookXml.match(/<sheet\b[^>]*r:id="([^"]+)"[^>]*>/i);
  const firstRelId = firstSheetMatch?.[1];
  if (!firstRelId) return "xl/worksheets/sheet1.xml";

  const relRegex = new RegExp(
    `<Relationship\\b[^>]*Id="${firstRelId}"[^>]*Target="([^"]+)"[^>]*/?>`,
    "i",
  );
  const relMatch = workbookRelsXml.match(relRegex);
  const target = relMatch?.[1];
  if (!target) return "xl/worksheets/sheet1.xml";
  const normalizedTarget = target.replace(/^\/+/, "");
  return normalizedTarget.startsWith("xl/") ? normalizedTarget : `xl/${normalizedTarget}`;
}

function ensureSheetPrFitToPage(xml: string) {
  const pageSetUpPrRegex = /<pageSetUpPr\b[^>]*\/>/;
  if (pageSetUpPrRegex.test(xml)) {
    return xml.replace(pageSetUpPrRegex, (tag) => upsertXmlAttr(tag, "fitToPage", "1"));
  }

  const sheetPrBlockRegex = /<sheetPr\b[^>]*>([\s\S]*?)<\/sheetPr>/;
  if (sheetPrBlockRegex.test(xml)) {
    return xml.replace(sheetPrBlockRegex, (block) =>
      block.replace("</sheetPr>", '<pageSetUpPr fitToPage="1"/></sheetPr>'),
    );
  }

  return xml.replace(/<worksheet\b[^>]*>/, (tag) => `${tag}<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`);
}

function ensureLandscapePageSetup(xml: string) {
  const pageSetupRegex = /<pageSetup\b[^>]*\/>/;
  if (pageSetupRegex.test(xml)) {
    return xml.replace(pageSetupRegex, (tag) => {
      let next = tag;
      next = upsertXmlAttr(next, "orientation", "landscape");
      next = upsertXmlAttr(next, "fitToWidth", "1");
      next = upsertXmlAttr(next, "fitToHeight", "0");
      next = upsertXmlAttr(next, "paperSize", "9");
      return next;
    });
  }

  const insertion = '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0" paperSize="9"/>';
  if (xml.includes("</pageMargins>")) {
    return xml.replace("</pageMargins>", `</pageMargins>${insertion}`);
  }
  if (xml.includes("</sheetData>")) {
    return xml.replace("</sheetData>", `</sheetData>${insertion}`);
  }
  return xml.replace("</worksheet>", `${insertion}</worksheet>`);
}

function listWorksheetXmlPaths(zip: JSZip) {
  return Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p) && !zip.files[p].dir)
    .sort((a, b) => {
      const na = Number.parseInt(a.match(/sheet(\d+)\.xml/i)?.[1] ?? "0", 10);
      const nb = Number.parseInt(b.match(/sheet(\d+)\.xml/i)?.[1] ?? "0", 10);
      return na - nb;
    });
}

function stripScaleFromPageSetupTag(tag: string) {
  return tag.replace(/\s+scale="[^"]*"/gi, "");
}

/** Márgenes más finos solo en Desesplast: más ancho útil para columnas. */
function tightenPageMarginsForDesesplastPdf(xml: string) {
  const marginTag =
    '<pageMargins left="0.1" right="0.1" top="0.2" bottom="0.2" header="0.1" footer="0.1"/>';
  const re = /<pageMargins\b[^>]*\/>/;
  if (re.test(xml)) {
    return xml.replace(re, marginTag);
  }
  if (xml.includes("</sheetData>")) {
    return xml.replace("</sheetData>", `</sheetData>${marginTag}`);
  }
  return xml.replace(/<worksheet\b[^>]*>/, (t) => `${t}${marginTag}`);
}

/**
 * A2 apaisado + escala % explícita (sin “ajustar a página”): LibreOffice headless
 * suele respetar esto mejor y evita tablas cortadas antes del raster.
 * paperSize 66 = A2 en la enumeración binaria de Excel/OOXML.
 */
function ensureLandscapeA2WithScale(xml: string, scalePercent: number) {
  const scaleStr = String(scalePercent);
  const pageSetupRegex = /<pageSetup\b[^>]*\/>/;
  if (pageSetupRegex.test(xml)) {
    return xml.replace(pageSetupRegex, (tag) => {
      let next = stripFitToPageAttrs(tag);
      next = stripScaleFromPageSetupTag(next);
      next = upsertXmlAttr(next, "orientation", "landscape");
      next = upsertXmlAttr(next, "paperSize", "66");
      next = upsertXmlAttr(next, "scale", scaleStr);
      return next;
    });
  }

  const insertion = `<pageSetup scale="${scaleStr}" orientation="landscape" paperSize="66"/>`;
  const marginSelfClosing = /<pageMargins\b[^>]*\/>/;
  if (marginSelfClosing.test(xml)) {
    return xml.replace(marginSelfClosing, (m) => `${m}${insertion}`);
  }
  if (xml.includes("</sheetData>")) {
    return xml.replace("</sheetData>", `</sheetData>${insertion}`);
  }
  return xml.replace("</worksheet>", `${insertion}</worksheet>`);
}

function desesplastPrepareWorksheetXml(xml: string, scalePercent: number) {
  let out = tightenPageMarginsForDesesplastPdf(xml);
  out = ensureSheetPrNoFitToPage(out);
  out = ensureLandscapeA2WithScale(out, scalePercent);
  return out;
}

async function prepareDesesplastWorkbookForPdf(
  sourceBytes: Uint8Array,
  desesPrintScalePercent: number,
) {
  try {
    const zip = await JSZip.loadAsync(sourceBytes);
    const paths = listWorksheetXmlPaths(zip);
    if (paths.length === 0) return sourceBytes;

    for (const path of paths) {
      const entry = zip.file(path);
      if (!entry) continue;
      const xml = await entry.async("text");
      zip.file(path, desesplastPrepareWorksheetXml(xml, desesPrintScalePercent));
    }
    return await zip.generateAsync({ type: "uint8array" });
  } catch {
    return sourceBytes;
  }
}

function upsertXmlAttr(tag: string, attrName: string, attrValue: string) {
  const attrRegex = new RegExp(`\\b${attrName}="[^"]*"`);
  if (attrRegex.test(tag)) {
    return tag.replace(attrRegex, `${attrName}="${attrValue}"`);
  }
  if (tag.endsWith("/>")) {
    return tag.replace("/>", ` ${attrName}="${attrValue}"/>`);
  }
  return tag.replace(">", ` ${attrName}="${attrValue}">`);
}
