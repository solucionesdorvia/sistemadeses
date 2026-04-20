import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createClient as createAdminClient } from "@supabase/supabase-js";
import JSZip from "jszip";

import { getClientEnv, getServerEnv } from "@/lib/config/env";
import { createClient } from "@/lib/supabase/server";

const execFileAsync = promisify(execFile);

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
            });
            await writeFile(localXlsx, xlsxForPdf);
            await runLibreOfficePdfConversion(localXlsx, tempRoot);
            const pdfBytes = await readFile(localPdf);
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

function isDesesplastResultsXlsx(fileName: string) {
  return fileName.toLowerCase().endsWith("_desesplast.xlsx");
}

async function buildXlsxBytesForPdf(params: {
  sourceBytes: Uint8Array;
  fileName: string;
  requestCompanyType: Body["companyType"];
  forceLandscapePdf: boolean;
  printScalePercent: number;
}): Promise<Uint8Array> {
  const {
    sourceBytes,
    fileName,
    requestCompanyType,
    forceLandscapePdf,
    printScalePercent,
  } = params;

  if (forceLandscapePdf) {
    return forceLandscapeAndFitToWidth(sourceBytes);
  }

  const skipPrintPatch =
    requestCompanyType === "desesplast" || isDesesplastResultsXlsx(fileName);

  if (skipPrintPatch) {
    return sourceBytes;
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
