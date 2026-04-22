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
import { refitPdfToA4Portrait } from "@/lib/pdf/refitToA4Portrait";
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
            const xlsxForPdf = await prepareCuentaCorrienteXlsxForPdf(sourceBytes);
            await writeFile(localXlsx, xlsxForPdf);
            await runLibreOfficePdfConversion(localXlsx, tempRoot);
            let pdfBytes: Buffer;
            try {
              const rawLoPdf = await readFile(localPdf);
              pdfBytes = await refitPdfToA4Portrait(Buffer.from(rawLoPdf));
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

function listWorksheetXmlPaths(zip: JSZip) {
  return Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p) && !zip.files[p].dir)
    .sort((a, b) => {
      const na = Number.parseInt(a.match(/sheet(\d+)\.xml/i)?.[1] ?? "0", 10);
      const nb = Number.parseInt(b.match(/sheet(\d+)\.xml/i)?.[1] ?? "0", 10);
      return na - nb;
    });
}

/**
 * Preproceso XLSX → PDF (LibreOffice). Misma lógica para Days, Deses y Americana.
 *
 * El motivo por el que Deses fallaba más que Days no era un flag distinto en este endpoint,
 * sino el origen del workbook: Deses suele venir de `.xls` → `.xlsx` (SheetJS o LibreOffice),
 * con `dimension`/`!ref` amplios o celdas implícitas; Days suele ser `.xlsx` de Excel, más
 * predecible para Calc al exportar PDF.
 */
async function prepareCuentaCorrienteXlsxForPdf(sourceBytes: Uint8Array) {
  let bytes = sourceBytes;
  try {
    // Quita celdas y columnas “fantasma” a la derecha: Calc reserva ancho aunque la celda
    // esté vacía, y <cols> hace el PDF con franja blanca + texto minúsculo al fit a ancho.
    bytes = trimXlsxWorkbookToTightDataBytes(sourceBytes);
  } catch (err) {
    console.error("[convert-pdf] trimXlsxWorkbookToTightDataBytes", err);
  }
  // A4 vertical: el listado suele caber en el ancho útil (~21 cm); antes A3 apaisado dejaba mucho blanco.
  return preparePdfWorkbookWithTightPrintArea(bytes, "9");
}

/** Elimina celdas fuera del rango con contenido y metadatos de columnas que ensanchan la grilla. */
function trimXlsxWorkbookToTightDataBytes(sourceBytes: Uint8Array): Uint8Array {
  const wb = XLSX.read(sourceBytes, {
    type: "array",
    cellDates: true,
    cellNF: true,
    cellFormula: true,
    cellStyles: true,
  });
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rng = getTightRangeFromSheetData(sheet);
    if (!rng) continue;
    for (const key of Object.keys(sheet)) {
      if (key.startsWith("!")) continue;
      if (!/^[A-Za-z]+\d+$/.test(key)) continue;
      let cell: { c: number; r: number };
      try {
        cell = XLSX.utils.decode_cell(key);
      } catch {
        delete (sheet as Record<string, unknown>)[key];
        continue;
      }
      if (
        cell.c < rng.s.c ||
        cell.c > rng.e.c ||
        cell.r < rng.s.r ||
        cell.r > rng.e.r
      ) {
        delete (sheet as Record<string, unknown>)[key];
      }
    }
    const merges = sheet["!merges"] as XLSX.Range[] | undefined;
    if (merges?.length) {
      sheet["!merges"] = merges.filter(
        (m) =>
          m.s.c >= rng.s.c && m.e.c <= rng.e.c && m.s.r >= rng.s.r && m.e.r <= rng.e.r,
      );
    }
    delete (sheet as { "!cols"?: unknown })["!cols"];
    const again = getTightRangeFromSheetData(sheet);
    if (again) {
      sheet["!ref"] = XLSX.utils.encode_range(again);
      applyUniformColumnWidthsForPrint(sheet, again);
    } else {
      delete sheet["!ref"];
    }
    (sheet as XLSX.WorkSheet)["!margins"] = {
      left: 0.12,
      right: 0.12,
      top: 0.16,
      bottom: 0.16,
      header: 0.1,
      footer: 0.1,
    };
  }
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", cellStyles: true });
  return new Uint8Array(out as ArrayBuffer);
}

/**
 * Anchos uniformes y moderados: reduce el ancho lógico total; al ajustar a 1 pág. de ancho,
 * Calc aplica un zoom mayor = texto más legible, menos "miniatura".
 * Columnas a la izquierda del rango: ocultas (no aportan ancho al layout).
 */
function applyUniformColumnWidthsForPrint(sheet: XLSX.WorkSheet, rng: XLSX.Range) {
  const WCH = 10;
  const cols: XLSX.ColInfo[] = [];
  for (let c = 0; c <= rng.e.c; c += 1) {
    if (c < rng.s.c) {
      cols.push({ hidden: true, wch: 0, width: 0 });
    } else {
      cols.push({ wch: WCH });
    }
  }
  sheet["!cols"] = cols;
}

type WorkbookWorksheetRef = {
  localSheetId: number;
  sheetName: string;
  worksheetPath: string;
};

/**
 * Orden real del workbook + localSheetId correcto (incluye hojas que no son worksheet).
 * Antes se asumía sheet1.xml=índice 0; si hay otra hoja antes, Print_Area quedaba mal y LO escalaba con área errónea.
 */
async function listWorkbookWorksheetRefs(zip: JSZip): Promise<WorkbookWorksheetRef[]> {
  const workbookXml = await zip.file("xl/workbook.xml")?.async("text");
  const workbookRelsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("text");
  const out: WorkbookWorksheetRef[] = [];
  if (!workbookXml || !workbookRelsXml) return out;

  const sheetTagMatches = [...workbookXml.matchAll(/<sheet\b([^/>]*)\/?>/gi)];
  let localSheetId = 0;
  for (const m of sheetTagMatches) {
    const attrs = m[1];
    const nameMatch = attrs.match(/\bname="([^"]*)"/);
    const ridMatch = attrs.match(/\br:id="([^"]+)"/i);
    const sheetName = nameMatch?.[1] ?? "";
    const rid = ridMatch?.[1];
    if (rid && sheetName) {
      const escapedRid = rid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const relRegex = new RegExp(
        `<Relationship\\b[^>]*Id="${escapedRid}"[^>]*Target="([^"]+)"[^>]*/?>`,
        "i",
      );
      const relMatch = workbookRelsXml.match(relRegex);
      const target = relMatch?.[1];
      if (target) {
        const normalized = target.replace(/^\/+/, "");
        const fullPath = normalized.startsWith("xl/") ? normalized : `xl/${normalized}`;
        if (
          /^xl\/worksheets\/sheet\d+\.xml$/i.test(fullPath) &&
          zip.files[fullPath] &&
          !zip.files[fullPath].dir
        ) {
          out.push({ localSheetId, sheetName, worksheetPath: fullPath });
        }
      }
    }
    localSheetId += 1;
  }
  return out;
}

async function fallbackWorksheetTargetsWithoutWorkbookOrder(
  zip: JSZip,
): Promise<Array<{ localSheetId: number; worksheetPath: string }>> {
  const paths = listWorksheetXmlPaths(zip);
  const list = paths.length > 0 ? paths : [await resolveFirstWorksheetPath(zip)];
  return list.map((worksheetPath, i) => ({ localSheetId: i, worksheetPath }));
}

function isRangeSubset(inner: XLSX.Range, outer: XLSX.Range): boolean {
  return (
    inner.s.c >= outer.s.c &&
    inner.s.r >= outer.s.r &&
    inner.e.c <= outer.e.c &&
    inner.e.r <= outer.e.r
  );
}

function rangeFromCellBounds(b: CellBounds): XLSX.Range {
  return { s: { c: b.minC, r: b.minR }, e: { c: b.maxC, r: b.maxR } };
}

/** Celdas con dato/ fórmula / texto; ignora celdas vacías con solo estilo (anchura fantasma en .xls). */
function sheetCellHasMeaningfulContent(cell: XLSX.CellObject | undefined): boolean {
  if (!cell) return false;
  if (cell.f) return true;
  if (cell.w != null && String(cell.w).trim() !== "") return true;
  if (cell.v === undefined) return false;
  if (typeof cell.v === "string" && cell.v.trim() === "") return false;
  if (cell.t === "z") return false;
  if (cell.t === "e" && (cell as { w?: string }).w) return true;
  return true;
}

/**
 * Rango solo desde celdas “con contenido” + merges, sin confiar en !ref
 * (a veces incluye columna ZZ vacía o estilada).
 */
function getTightRangeFromSheetData(sheet: XLSX.WorkSheet): XLSX.Range | null {
  const keys = Object.keys(sheet).filter((k) => !k.startsWith("!"));
  if (keys.length === 0) return null;

  let minC = Infinity;
  let minR = Infinity;
  let maxC = 0;
  let maxR = 0;
  let any = false;
  for (const addr of keys) {
    if (!/^[A-Za-z]+\d+$/.test(addr)) continue;
    if (!sheetCellHasMeaningfulContent(sheet[addr] as XLSX.CellObject)) continue;
    let cell: { c: number; r: number };
    try {
      cell = XLSX.utils.decode_cell(addr);
    } catch {
      continue;
    }
    any = true;
    minC = Math.min(minC, cell.c);
    minR = Math.min(minR, cell.r);
    maxC = Math.max(maxC, cell.c);
    maxR = Math.max(maxR, cell.r);
  }
  if (!any || !Number.isFinite(minC)) return null;

  let rng: XLSX.Range = { s: { c: minC, r: minR }, e: { c: maxC, r: maxR } };
  const merges = sheet["!merges"] as XLSX.Range[] | undefined;
  if (merges?.length) {
    for (const m of merges) {
      rng.s.c = Math.min(rng.s.c, m.s.c, m.e.c);
      rng.s.r = Math.min(rng.s.r, m.s.r, m.e.r);
      rng.e.c = Math.max(rng.e.c, m.s.c, m.e.c);
      rng.e.r = Math.max(rng.e.r, m.s.r, m.e.r);
    }
  }
  return rng;
}

function unionRange(a: XLSX.Range, b: XLSX.Range): XLSX.Range {
  return {
    s: { c: Math.min(a.s.c, b.s.c), r: Math.min(a.s.r, b.s.r) },
    e: { c: Math.max(a.e.c, b.e.c), r: Math.max(a.e.r, b.e.r) },
  };
}

/**
 * Rango útil: xml (hoja) vs objeto SheetJS; el subconjunto más ajustado que sigue conteniendo datos.
 * Deses/.xls→xlsx: !ref a menudo ancho; el XML a veces omite r= en celdas.
 */
function pickTightPrintRange(
  fromSheet: XLSX.Range | null,
  fromXml: CellBounds | null,
): XLSX.Range | null {
  if (fromXml) {
    const rXml = rangeFromCellBounds(fromXml);
    if (!fromSheet) return rXml;
    if (isRangeSubset(rXml, fromSheet)) return rXml;
    if (isRangeSubset(fromSheet, rXml)) return fromSheet;
    return unionRange(fromSheet, rXml);
  }
  return fromSheet;
}

async function preparePdfWorkbookWithTightPrintArea(sourceBytes: Uint8Array, paperSize: string) {
  try {
    const zip = await JSZip.loadAsync(sourceBytes);
    let wb: XLSX.WorkBook | null = null;
    try {
      wb = XLSX.read(sourceBytes, {
        type: "array",
        cellDates: true,
        cellNF: true,
        cellFormula: true,
        cellStyles: true,
      });
    } catch {
      wb = null;
    }

    const refs = await listWorkbookWorksheetRefs(zip);
    const targets: Array<
      WorkbookWorksheetRef | { localSheetId: number; worksheetPath: string; sheetName?: string }
    > =
      refs.length > 0 ? refs : await fallbackWorksheetTargetsWithoutWorkbookOrder(zip);

    const printEntries: Array<{ sheetIndex: number; areaDollar: string }> = [];

    for (const t of targets) {
      const worksheetPath = t.worksheetPath;
      const localSheetId = t.localSheetId;
      const sheetName = "sheetName" in t && t.sheetName ? t.sheetName : wb?.SheetNames?.[localSheetId];

      const worksheetFile = zip.file(worksheetPath);
      if (!worksheetFile) continue;
      let xml = await worksheetFile.async("text");

      const xmlBounds = computeTightContentBoundsFromWorksheetXml(xml);
      let fromSheet: XLSX.Range | null = null;
      if (wb && sheetName && wb.Sheets[sheetName]) {
        fromSheet = getTightRangeFromSheetData(wb.Sheets[sheetName]);
      }
      const range = pickTightPrintRange(fromSheet, xmlBounds);
      if (range) {
        xml = applyTightDimensionFromRange(xml, range, 1, 1);
      } else {
        xml = applyTightDimensionFromContent(xml, 1, 1);
      }

      const area = getDollarPrintAreaFromWorksheetXml(xml);
      if (area) printEntries.push({ sheetIndex: localSheetId, areaDollar: area });
      xml = ensureSheetPrFitToPage(xml);
      xml = applyOoxmlPrintSectionPortraitA4FitWidth(xml, paperSize);
      zip.file(worksheetPath, xml);
    }

    await patchWorkbookPrintAreas(zip, printEntries);
    return await zip.generateAsync({ type: "uint8array" });
  } catch (err) {
    console.error("[convert-pdf] preparePdfWorkbookWithTightPrintArea", err);
    return sourceBytes;
  }
}

/**
 * Reescribe la sección de impresión con orden OOXML válido. Antes, pageMargins/pageSetup
 * podían quedar *antes* de sheetData o mal enlazados; Calc ignoraba orientación = portrait
 * y seguía en apaisado. Orden: … datos … → printOptions, pageMargins, pageSetup.
 */
/** Incluye tags con prefijo XML (`x:pageSetup`): si no se borran, Calc sigue el papel/orientación viejos. */
function stripWorksheetPrintElementsAllForms(s: string): string {
  let out = s;
  const selfClose = (local: string) =>
    new RegExp(`<(?:[\\w.-]+:)?${local}\\b[^>]*/>`, "gi");
  const paired = (local: string) =>
    new RegExp(
      `<(?:[\\w.-]+:)?${local}\\b[^>]*>[\\s\\S]*?</(?:[\\w.-]+:)?${local}>`,
      "gi",
    );
  for (const name of ["printOptions", "pageMargins", "pageSetup"] as const) {
    out = out.replace(selfClose(name), "");
    out = out.replace(paired(name), "");
  }
  return out;
}

function applyOoxmlPrintSectionPortraitA4FitWidth(xml: string, paperSize: string) {
  let s = stripWorksheetPrintElementsAllForms(xml);

  const block = `<printOptions horizontalCentered="0" verticalCentered="0"/>
<pageMargins left="0.12" right="0.12" top="0.16" bottom="0.16" header="0.1" footer="0.1"/>
<pageSetup orientation="portrait" fitToWidth="1" fitToHeight="0" paperSize="${paperSize}"/>`;

  const insertBefore = (re: RegExp) => s.replace(re, (m) => `${block}\n${m}`);

  if (/<(?:[\w.-]+:)?headerFooter\b/i.test(s)) {
    return insertBefore(/<(?:[\w.-]+:)?headerFooter\b/i);
  }
  if (/<(?:[\w.-]+:)?drawing\b/i.test(s)) {
    return insertBefore(/<(?:[\w.-]+:)?drawing\b/i);
  }
  if (/<(?:[\w.-]+:)?legacyDrawing\b/i.test(s)) {
    return insertBefore(/<(?:[\w.-]+:)?legacyDrawing\b/i);
  }
  return s.replace(/<\/worksheet>/i, `${block}\n</worksheet>`);
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

type CellBounds = { minR: number; maxR: number; minC: number; maxC: number };

function mergeCellBounds(a: CellBounds | null, b: CellBounds | null): CellBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minC: Math.min(a.minC, b.minC),
    minR: Math.min(a.minR, b.minR),
    maxC: Math.max(a.maxC, b.maxC),
    maxR: Math.max(a.maxR, b.maxR),
  };
}

function expandBoundsWithPoint(b: CellBounds, c: number, r: number): void {
  b.minC = Math.min(b.minC, c);
  b.maxC = Math.max(b.maxC, c);
  b.minR = Math.min(b.minR, r);
  b.maxR = Math.max(b.maxR, r);
}

/**
 * Incluye <c r="..."> (mayúsc/minúsc), mergeCells, y celdas sin r= (orden OOXML en la fila).
 * En .xls→.xlsx LibreOffice/SheetJS a veces omiten r= o dejan !ref enorme.
 */
function computeTightContentBoundsFromWorksheetXml(xml: string): CellBounds | null {
  let b: CellBounds | null = null;
  let any = false;

  const cellRe = /<c\b[^>]*\br="([A-Za-z]+)(\d+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml)) !== null) {
    if (!b) b = { minR: Infinity, maxR: 0, minC: Infinity, maxC: 0 };
    any = true;
    const col = XLSX.utils.decode_col(m[1].toUpperCase());
    const row = Number(m[2]) - 1;
    expandBoundsWithPoint(b, col, row);
  }

  const mergeRe = /<mergeCell\b[^>]*\bref="([^"]+)"/gi;
  while ((m = mergeRe.exec(xml)) !== null) {
    try {
      const rng = XLSX.utils.decode_range(m[1]);
      if (!b) b = { minR: Infinity, maxR: 0, minC: Infinity, maxC: 0 };
      any = true;
      b.minC = Math.min(b.minC, rng.s.c, rng.e.c);
      b.maxC = Math.max(b.maxC, rng.s.c, rng.e.c);
      b.minR = Math.min(b.minR, rng.s.r, rng.e.r);
      b.maxR = Math.max(b.maxR, rng.s.r, rng.e.r);
    } catch {
      /* ignore bad merge ref */
    }
  }

  const implicit = computeImplicitContentBoundsFromSheetDataXml(xml);
  b = mergeCellBounds(b, implicit);
  if (implicit) any = true;

  if (!any || !b || !Number.isFinite(b.minC)) return null;
  return b;
}

/** Celdas sin r= en <sheetData> (columna implícita según ECMA-376 / LibreOffice). */
function computeImplicitContentBoundsFromSheetDataXml(worksheetXml: string): CellBounds | null {
  const inner = worksheetXml.match(/<sheetData>([\s\S]*?)<\/sheetData>/i)?.[1];
  if (!inner) return null;

  let b: CellBounds | null = null;
  const rowRe = /<row(\s[^>]*)>([\s\S]*?)<\/row>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(inner)) !== null) {
    const rowAttrs = rm[1] ?? "";
    const content = rm[2] ?? "";
    const rowM = rowAttrs.match(/\br="(\d+)"/i);
    let row0: number | null = rowM?.[1] ? Number(rowM[1]) - 1 : null;
    if (row0 === null) {
      const firstC = content.match(/<c[^>]*\br="[A-Za-z]+(\d+)"/i);
      if (firstC?.[1]) row0 = Number(firstC[1]) - 1;
    }
    if (row0 === null) continue;

    let nextCol = 0;
    const cTags = content.matchAll(/<c[^>]*>/g);
    for (const cm of cTags) {
      const openTag = cm[0];
      const refMatch = openTag.match(/\br="([A-Za-z]+)(\d+)"/i);
      let col: number;
      if (refMatch?.[1]) {
        col = XLSX.utils.decode_col(refMatch[1].toUpperCase());
        nextCol = col + 1;
      } else {
        col = nextCol;
        nextCol += 1;
      }
      if (!b) b = { minR: Infinity, maxR: 0, minC: Infinity, maxC: 0 };
      expandBoundsWithPoint(b, col, row0);
    }
  }
  return b;
}

function computeContentBoundsFromWorksheetXml(xml: string): CellBounds | null {
  return computeTightContentBoundsFromWorksheetXml(xml);
}

function applyTightDimensionFromRange(
  xml: string,
  rng: XLSX.Range,
  padCols: number,
  padRows: number,
): string {
  const ref = XLSX.utils.encode_range({
    s: { r: rng.s.r, c: rng.s.c },
    e: { r: rng.e.r + padRows, c: rng.e.c + padCols },
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

function applyTightDimensionFromContent(xml: string, padCols: number, padRows: number): string {
  const b = computeContentBoundsFromWorksheetXml(xml);
  if (!b) return xml;
  return applyTightDimensionFromRange(
    xml,
    { s: { r: b.minR, c: b.minC }, e: { r: b.maxR, c: b.maxC } },
    padCols,
    padRows,
  );
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
