import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createClient as createAdminClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import * as XLSX from "xlsx";

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

function isDesesplastResultsXlsx(fileName: string) {
  return fileName.toLowerCase().endsWith("_desesplast.xlsx");
}

/**
 * Área de impresión ajustada al contenido + fit ancho en papel grande.
 * Sin esto, el "área" implícita es enorme y el PDF deja bandas vacías o escala mal.
 */
async function buildXlsxBytesForPdf(params: {
  sourceBytes: Uint8Array;
  fileName: string;
  requestCompanyType: Body["companyType"];
}): Promise<Uint8Array> {
  const { sourceBytes, fileName, requestCompanyType } = params;

  const isDesesplast =
    requestCompanyType === "desesplast" || isDesesplastResultsXlsx(fileName);

  if (isDesesplast) {
    return prepareDesesplastPdfPrint(sourceBytes);
  }
  return prepareDaysAmericanaPdfPrint(sourceBytes);
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
      "pdf:calc_pdf_Export",
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

function stripFitToPageAttrs(tag: string) {
  return tag
    .replace(/\s+fitToWidth="[^"]*"/gi, "")
    .replace(/\s+fitToHeight="[^"]*"/gi, "");
}

function stripScaleFromPageSetupTag(tag: string) {
  return tag.replace(/\s+scale="[^"]*"/gi, "");
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

async function prepareDaysAmericanaPdfPrint(sourceBytes: Uint8Array) {
  return preparePdfWorkbookWithTightPrintArea(sourceBytes, "8", false);
}

async function prepareDesesplastPdfPrint(sourceBytes: Uint8Array) {
  return preparePdfWorkbookWithTightPrintArea(sourceBytes, "66", true);
}

async function preparePdfWorkbookWithTightPrintArea(
  sourceBytes: Uint8Array,
  paperSize: string,
  useDesesMargins: boolean,
) {
  try {
    const zip = await JSZip.loadAsync(sourceBytes);
    const paths = listWorksheetXmlPaths(zip);
    const targets = paths.length > 0 ? paths : [await resolveFirstWorksheetPath(zip)];
    const printEntries: Array<{ sheetIndex: number; areaDollar: string }> = [];

    for (let sheetIndex = 0; sheetIndex < targets.length; sheetIndex += 1) {
      const worksheetPath = targets[sheetIndex];
      const worksheetFile = zip.file(worksheetPath);
      if (!worksheetFile) continue;
      let xml = await worksheetFile.async("text");
      xml = applyTightDimensionFromContent(xml, 1, 1);
      const area = getDollarPrintAreaFromWorksheetXml(xml);
      if (area) printEntries.push({ sheetIndex, areaDollar: area });
      if (useDesesMargins) xml = tightenPageMarginsForDeses(xml);
      xml = ensureSheetPrFitToPage(xml);
      xml = ensureLandscapeFitToWidthPrint(xml, paperSize);
      zip.file(worksheetPath, xml);
    }

    await patchWorkbookPrintAreas(zip, printEntries);
    return await zip.generateAsync({ type: "uint8array" });
  } catch {
    return sourceBytes;
  }
}

function tightenPageMarginsForDeses(xml: string) {
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

/** Apaisado + ajustar a 1 página de ancho (requiere área de impresión acotada). paperSize 8=A3, 66=A2. */
function ensureLandscapeFitToWidthPrint(xml: string, paperSize: string) {
  const pageSetupRegex = /<pageSetup\b[^>]*\/>/;
  if (pageSetupRegex.test(xml)) {
    return xml.replace(pageSetupRegex, (tag) => {
      let next = stripFitToPageAttrs(tag);
      next = stripScaleFromPageSetupTag(next);
      next = upsertXmlAttr(next, "orientation", "landscape");
      next = upsertXmlAttr(next, "fitToWidth", "1");
      next = upsertXmlAttr(next, "fitToHeight", "0");
      next = upsertXmlAttr(next, "paperSize", paperSize);
      return next;
    });
  }

  const insertion = `<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0" paperSize="${paperSize}"/>`;
  if (xml.includes("</pageMargins>")) {
    return xml.replace("</pageMargins>", `</pageMargins>${insertion}`);
  }
  if (xml.includes("</sheetData>")) {
    return xml.replace("</sheetData>", `</sheetData>${insertion}`);
  }
  return xml.replace("</worksheet>", `${insertion}</worksheet>`);
}

type CellBounds = { minR: number; maxR: number; minC: number; maxC: number };

function computeContentBoundsFromWorksheetXml(xml: string): CellBounds | null {
  const b: CellBounds = { minR: Infinity, maxR: 0, minC: Infinity, maxC: 0 };
  let any = false;

  const cellRe = /<c\b[^>]*\br="([A-Z]{1,3})(\d+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml)) !== null) {
    any = true;
    const c = XLSX.utils.decode_col(m[1]);
    const r = Number(m[2]) - 1;
    b.minC = Math.min(b.minC, c);
    b.maxC = Math.max(b.maxC, c);
    b.minR = Math.min(b.minR, r);
    b.maxR = Math.max(b.maxR, r);
  }

  const mergeRe = /<mergeCell\b[^>]*\bref="([^"]+)"/gi;
  while ((m = mergeRe.exec(xml)) !== null) {
    try {
      const rng = XLSX.utils.decode_range(m[1]);
      any = true;
      b.minC = Math.min(b.minC, rng.s.c);
      b.maxC = Math.max(b.maxC, rng.e.c);
      b.minR = Math.min(b.minR, rng.s.r);
      b.maxR = Math.max(b.maxR, rng.e.r);
    } catch {
      /* ignore bad merge ref */
    }
  }

  if (!any || !Number.isFinite(b.minC)) return null;
  return b;
}

function applyTightDimensionFromContent(xml: string, padCols: number, padRows: number): string {
  const b = computeContentBoundsFromWorksheetXml(xml);
  if (!b) return xml;
  b.maxC += padCols;
  b.maxR += padRows;
  const ref = XLSX.utils.encode_range({
    s: { r: b.minR, c: b.minC },
    e: { r: b.maxR, c: b.maxC },
  });
  const dimRe = /<dimension\b[^>]*\/>/;
  if (dimRe.test(xml)) {
    return xml.replace(dimRe, `<dimension ref="${ref}"/>`);
  }
  if (xml.includes("<sheetData>")) {
    return xml.replace("<sheetData>", `<dimension ref="${ref}"/><sheetData>`);
  }
  return xml.replace(/<worksheet\b[^>]*>/, (t) => `${t}<dimension ref="${ref}"/>`);
}

function getDollarPrintAreaFromWorksheetXml(xml: string): string | null {
  const dm = xml.match(/<dimension\b[^>]*\bref="([^"]+)"/);
  if (!dm?.[1]) return null;
  try {
    const rng = XLSX.utils.decode_range(dm[1]);
    const a = `$${XLSX.utils.encode_col(rng.s.c)}$${rng.s.r + 1}`;
    const b = `$${XLSX.utils.encode_col(rng.e.c)}$${rng.e.r + 1}`;
    return `${a}:${b}`;
  } catch {
    return null;
  }
}

function parseSheetNamesInOrder(workbookXml: string): string[] {
  const tags = workbookXml.match(/<sheet\b[^>]*(?:\/>|>)/gi) ?? [];
  const names: string[] = [];
  for (const tag of tags) {
    const nm = tag.match(/\bname="([^"]*)"/);
    if (nm?.[1] !== undefined) names.push(nm[1]);
  }
  return names;
}

function quoteSheetNameForRange(name: string): string {
  if (/[^A-Za-z0-9_.]/.test(name) || /^\d/.test(name)) {
    return `'${name.replace(/'/g, "''")}'`;
  }
  return name;
}

async function patchWorkbookPrintAreas(
  zip: JSZip,
  entries: Array<{ sheetIndex: number; areaDollar: string }>,
) {
  if (entries.length === 0) return;
  const wbFile = zip.file("xl/workbook.xml");
  if (!wbFile) return;
  let wb = await wbFile.async("text");
  const sheetNames = parseSheetNamesInOrder(wb);
  wb = wb.replace(/<definedName\s+name="_xlnm\.Print_Area"[^>]*\/>/g, "");
  wb = wb.replace(/<definedName\s+name="_xlnm\.Print_Area"[^>]*>[^<]*<\/definedName>/g, "");

  const newTags = entries
    .map(({ sheetIndex, areaDollar }) => {
      const sn = sheetNames[sheetIndex];
      if (!sn) return "";
      return `<definedName name="_xlnm.Print_Area" localSheetId="${sheetIndex}">${quoteSheetNameForRange(sn)}!${areaDollar}</definedName>`;
    })
    .filter(Boolean)
    .join("");

  if (!newTags) return;

  if (/<definedNames>[\s\S]*<\/definedNames>/.test(wb)) {
    wb = wb.replace(/<\/definedNames>/, `${newTags}</definedNames>`);
  } else {
    wb = wb.replace(/<\/workbook>/, `<definedNames>${newTags}</definedNames></workbook>`);
  }
  zip.file("xl/workbook.xml", wb);
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
