import JSZip from "jszip";
import * as XLSX from "xlsx";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { pathSafeVendorName } from "@/lib/vendors/pathSafeVendorName";

export const runtime = "nodejs";

type Body = {
  companyType: "americana" | "days" | "desesplast";
  filePaths: string[];
};

type VendorBlock = { vendorName: string; ranges: Array<{ start: number; end: number }> };

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    if (!body?.filePaths?.length) {
      return Response.json({ message: "No se recibieron archivos para procesar." }, { status: 400 });
    }

    const supabase = await createClient();
    const admin = createAdminClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return Response.json({ message: "Sesion invalida." }, { status: 401 });

    const processedVendors = new Set<string>();
    const vendorIdentityMap = await loadExistingVendorIdentityMap(admin, user.id);

    for (const filePath of body.filePaths) {
      const fileRow = await admin
        .from("files")
        .select("id,user_id")
        .eq("file_path", filePath)
        .eq("user_id", user.id)
        .single();

      if (fileRow.error || !fileRow.data) {
        await markFileAsError(admin, user.id, filePath, "No se encontro registro del archivo.");
        continue;
      }

      const fileId = fileRow.data.id;
      try {
        const downloaded = await admin.storage.from("uploads").download(filePath);
        if (downloaded.error || !downloaded.data) {
          throw new Error(downloaded.error?.message ?? "No se pudo descargar archivo.");
        }

        const sourceArrayBuffer = await downloaded.data.arrayBuffer();
        if (!filePath.toLowerCase().endsWith(".xlsx")) {
          throw new Error("Formato no soportado en servidor. Se requiere .xlsx.");
        }

        const workbook = XLSX.read(sourceArrayBuffer, {
          type: "array",
          cellStyles: true,
          cellNF: true,
          cellFormula: true,
          cellDates: true,
        });
        const sourceSheetName = workbook.SheetNames[0] ?? "Sheet1";
        const sheet = workbook.Sheets[sourceSheetName];
        if (!sheet) throw new Error("No se pudo leer la hoja principal.");

        const literalCropContext = await createLiteralCropContext(sourceArrayBuffer);
        const blocks = detectVendorBlocks(sheet, body.companyType);
        let vendorsFoundCount = 0;

        for (const block of blocks) {
          if (!block.vendorName || block.ranges.length === 0) continue;
          const normalized = normalizeVendorName(block.vendorName);
          if (!normalized) continue;

          const identityKey = buildVendorIdentityKey(normalized);
          const existingVendor = vendorIdentityMap.get(identityKey);
          const canonicalNormalized = existingVendor?.normalizedName ?? normalized;
          const safeName = pathSafeVendorName(canonicalNormalized);

          const patched = await cropXlsxWorkbookFromContext(literalCropContext, block.ranges);
          const outputPath = `${user.id}/vendedores/${safeName}/${canonicalNormalized}_${body.companyType}.xlsx`;
          const uploadResult = await admin.storage
            .from("results")
            .upload(outputPath, patched, { upsert: true });
          if (uploadResult.error) throw new Error(uploadResult.error.message);

          if (existingVendor) {
            const vendorUpdate = await admin
              .from("vendors")
              .update({ original_name: block.vendorName })
              .eq("id", existingVendor.id);
            if (vendorUpdate.error) throw new Error(vendorUpdate.error.message);
          } else {
            const vendorInsert = await admin
              .from("vendors")
              .insert({
                user_id: user.id,
                normalized_name: canonicalNormalized,
                original_name: block.vendorName,
                company_type: body.companyType,
              })
              .select("id,normalized_name")
              .single();
            if (vendorInsert.error) throw new Error(vendorInsert.error.message);
            vendorIdentityMap.set(identityKey, {
              id: vendorInsert.data.id,
              normalizedName: vendorInsert.data.normalized_name,
            });
          }

          processedVendors.add(canonicalNormalized);
          vendorsFoundCount += 1;
        }

        await markFileAsCompleted(admin, user.id, fileId, filePath, vendorsFoundCount);
      } catch (error) {
        await markFileAsError(
          admin,
          user.id,
          filePath,
          error instanceof Error ? error.message : "No se pudo procesar archivo.",
        );
      }
    }

    return Response.json({ ok: true, processedVendors: Array.from(processedVendors) });
  } catch (error) {
    return Response.json(
      { message: error instanceof Error ? error.message : "Error al procesar cuentas corrientes." },
      { status: 500 },
    );
  }
}

function detectVendorBlocks(sheet: XLSX.WorkSheet, companyType: Body["companyType"]) {
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const markers = new Map<number, string>();
  const regex = /vendedor\s*:\s*([a-z0-9 ,.'-]+)/i;

  if (companyType === "americana") {
    const merges = sheet["!merges"] ?? [];
    for (const merge of merges) {
      const span = merge.e.c - merge.s.c + 1;
      if (merge.s.c === 0 && span >= 9) {
        const address = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
        const value = String(sheet[address]?.v ?? "");
        const match = value.match(regex);
        if (match?.[1]) markers.set(merge.s.r, match[1].trim());
      }
    }
    if (markers.size === 0) {
      for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
        const asText = readRowText(sheet, rowIndex, 0, 30);
        const match = asText.match(regex);
        if (match?.[1]) markers.set(rowIndex, match[1].trim());
      }
    }
  } else {
    // Days: encabezados suelen arrancar en col C (índice 2). Desesplast .xls→SheetJS a veces
    // desplaza "Vendedor:" hacia la izquierda; escanear desde A evita 0 vendedores.
    const vendorLabelFromCol = companyType === "desesplast" ? 0 : 2;
    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
      const asText = readRowText(sheet, rowIndex, vendorLabelFromCol, 35);
      const match = asText.match(regex);
      if (match?.[1]) markers.set(rowIndex, match[1].trim());
    }
  }

  const sorted = [...markers.entries()].sort((a, b) => a[0] - b[0]);
  const blocks: VendorBlock[] = [];
  sorted.forEach(([startRow, name], index) => {
    const nextStart = sorted[index + 1]?.[0] ?? range.e.r + 1;
    let endRow = Math.max(startRow, nextStart - 1);
    if (companyType !== "americana") {
      const totalRow = findVendorTotalRow(sheet, startRow, endRow, name);
      if (totalRow !== null) endRow = totalRow;
    }
    if (endRow >= startRow) {
      blocks.push({ vendorName: name, ranges: [{ start: startRow, end: endRow }] });
    }
  });

  return dedupeByNormalizedVendor(blocks);
}

function readRowText(sheet: XLSX.WorkSheet, rowIndex: number, fromCol: number, toCol: number) {
  const chunks: string[] = [];
  for (let col = fromCol; col <= toCol; col += 1) {
    const addr = XLSX.utils.encode_cell({ r: rowIndex, c: col });
    const raw = sheet[addr]?.w ?? sheet[addr]?.v ?? "";
    const text = String(raw).trim();
    if (text) chunks.push(text);
  }
  return chunks.join(" ");
}

function findVendorTotalRow(
  sheet: XLSX.WorkSheet,
  fromRow: number,
  toRow: number,
  vendorName: string,
) {
  const normalizedVendor = normalizeCompareText(normalizeVendorName(vendorName));
  if (!normalizedVendor) return null;
  const tokens = normalizedVendor.split(" ").filter(Boolean);
  for (let rowIndex = fromRow + 1; rowIndex <= toRow; rowIndex += 1) {
    const rowText = normalizeCompareText(readRowText(sheet, rowIndex, 0, 30));
    if (!rowText.startsWith("total")) continue;
    if (rowText.includes(normalizedVendor)) return rowIndex;
    const tokenMatches = tokens.filter((token) => rowText.includes(token)).length;
    if (tokens.length > 0 && tokenMatches >= Math.max(1, tokens.length - 1)) return rowIndex;
  }
  return null;
}

type LiteralCropContext = {
  zip: JSZip;
  worksheetPath: string;
  sourceWorksheetXml: string;
};

async function createLiteralCropContext(sourceWorkbookBuffer: ArrayBuffer): Promise<LiteralCropContext> {
  const zip = await JSZip.loadAsync(sourceWorkbookBuffer);
  const worksheetPath = await resolveFirstWorksheetPath(zip);
  const worksheetFile = zip.file(worksheetPath);
  if (!worksheetFile) throw new Error("No se encontro worksheet en el archivo XLSX.");
  const sourceWorksheetXml = await worksheetFile.async("text");
  return { zip, worksheetPath, sourceWorksheetXml };
}

async function cropXlsxWorkbookFromContext(
  context: LiteralCropContext,
  ranges: Array<{ start: number; end: number }>,
) {
  const croppedWorksheetXml = cropWorksheetXmlByRanges(context.sourceWorksheetXml, ranges);
  context.zip.file(context.worksheetPath, croppedWorksheetXml);
  const out = await context.zip.generateAsync({ type: "uint8array" });
  context.zip.file(context.worksheetPath, context.sourceWorksheetXml);
  return out;
}

function cropWorksheetXmlByRanges(worksheetXml: string, ranges: Array<{ start: number; end: number }>) {
  const normalizedRanges = ranges
    .map((range) => ({ start: range.start + 1, end: range.end + 1 }))
    .sort((a, b) => a.start - b.start);
  const inRange = (row: number) => normalizedRanges.some((r) => row >= r.start && row <= r.end);
  const rowMap = new Map<number, number>();
  let nextRow = 1;

  const sheetDataRegex = /<sheetData>([\s\S]*?)<\/sheetData>/;
  const sheetDataMatch = worksheetXml.match(sheetDataRegex);
  if (!sheetDataMatch) return worksheetXml;
  const rowBlocks = sheetDataMatch[1].match(/<row\b[\s\S]*?<\/row>/g) ?? [];
  const keptRows: string[] = [];

  for (const rowBlock of rowBlocks) {
    const sourceRow = parseRowNumberFromRowBlock(rowBlock);
    if (sourceRow === null || !inRange(sourceRow)) continue;
    rowMap.set(sourceRow, nextRow);
    keptRows.push(remapRowBlock(rowBlock, sourceRow, nextRow));
    nextRow += 1;
  }

  let updatedXml = worksheetXml.replace(sheetDataRegex, `<sheetData>${keptRows.join("")}</sheetData>`);
  updatedXml = remapMergeCellsBlock(updatedXml, rowMap);
  updatedXml = remapDimensionBlock(updatedXml, rowMap);
  return updatedXml;
}

function parseRowNumberFromRowBlock(rowBlock: string) {
  const rowMatch = rowBlock.match(/\br="(\d+)"/);
  if (rowMatch?.[1]) return Number(rowMatch[1]);
  const firstCellRef = rowBlock.match(/<c\b[^>]*\br="([A-Z]+)(\d+)"/);
  if (firstCellRef?.[2]) return Number(firstCellRef[2]);
  return null;
}

function remapRowBlock(rowBlock: string, fromRow: number, toRow: number) {
  let updated = rowBlock;
  if (/\b r="\d+"/.test(updated)) updated = updated.replace(/\b r="\d+"/, ` r="${toRow}"`);
  else updated = updated.replace("<row", `<row r="${toRow}"`);

  updated = updated.replace(/\br="([A-Z]+)(\d+)"/g, (_f, col, row) => {
    const numericRow = Number(row);
    if (numericRow !== fromRow) return `r="${col}${row}"`;
    return `r="${col}${toRow}"`;
  });
  updated = updated.replace(/\bref="([A-Z]+\d+:[A-Z]+\d+)"/g, (_f, ref) => {
    const shifted = shiftRangeRefByOffset(ref, toRow - fromRow);
    return `ref="${shifted}"`;
  });
  return updated;
}

function remapMergeCellsBlock(worksheetXml: string, rowMap: Map<number, number>) {
  const mergeBlockRegex = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/;
  const mergeBlockMatch = worksheetXml.match(mergeBlockRegex);
  if (!mergeBlockMatch) return worksheetXml;
  const mergeRefs = [...mergeBlockMatch[1].matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/>/g)];
  const remappedMergeTags: string[] = [];
  for (const match of mergeRefs) {
    const ref = match[1];
    const [startRef, endRef = startRef] = ref.split(":");
    const start = decodeCellRef(startRef);
    const end = decodeCellRef(endRef);
    if (!start || !end) continue;
    const mappedStart = rowMap.get(start.row);
    const mappedEnd = rowMap.get(end.row);
    if (mappedStart === undefined || mappedEnd === undefined) continue;
    remappedMergeTags.push(`<mergeCell ref="${start.col}${mappedStart}:${end.col}${mappedEnd}"/>`);
  }
  if (remappedMergeTags.length === 0) return worksheetXml.replace(mergeBlockRegex, "");
  return worksheetXml.replace(
    mergeBlockRegex,
    `<mergeCells count="${remappedMergeTags.length}">${remappedMergeTags.join("")}</mergeCells>`,
  );
}

function remapDimensionBlock(worksheetXml: string, rowMap: Map<number, number>) {
  const keys = [...rowMap.values()];
  if (keys.length === 0) return worksheetXml;
  const minRow = Math.min(...keys) - 1;
  const maxRow = Math.max(...keys) - 1;
  const currentRefMatch = worksheetXml.match(/<dimension\b[^>]*\bref="([^"]+)"[^>]*\/>/);
  if (!currentRefMatch?.[1]) return worksheetXml;
  let colStart = "A";
  let colEnd = "A";
  try {
    const decoded = XLSX.utils.decode_range(currentRefMatch[1]);
    colStart = XLSX.utils.encode_col(decoded.s.c);
    colEnd = XLSX.utils.encode_col(decoded.e.c);
  } catch {
    // noop
  }
  const nextRef = `${colStart}${minRow + 1}:${colEnd}${maxRow + 1}`;
  return worksheetXml.replace(/<dimension\b[^>]*\bref="[^"]+"[^>]*\/>/, `<dimension ref="${nextRef}"/>`);
}

function decodeCellRef(ref: string) {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match?.[1] || !match[2]) return null;
  return { col: match[1], row: Number(match[2]) };
}

function shiftRangeRefByOffset(ref: string, offset: number) {
  const [start, end = start] = ref.split(":");
  return `${shiftCellRefByOffset(start, offset)}:${shiftCellRefByOffset(end, offset)}`;
}

function shiftCellRefByOffset(ref: string, offset: number) {
  const parsed = decodeCellRef(ref);
  if (!parsed) return ref;
  return `${parsed.col}${Math.max(1, parsed.row + offset)}`;
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
  if (normalizedTarget.startsWith("xl/")) return normalizedTarget;
  return `xl/${normalizedTarget}`;
}

async function markFileAsCompleted(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  fileId: string,
  filePath: string,
  vendorsFoundCount: number,
) {
  await admin
    .from("files")
    .update({ status: "completed", error_message: null })
    .eq("file_path", filePath)
    .eq("user_id", userId);
  await admin.from("processes").insert({
    user_id: userId,
    file_id: fileId,
    records_processed: vendorsFoundCount,
  });
}

async function markFileAsError(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  filePath: string,
  message: string,
) {
  await admin
    .from("files")
    .update({ status: "error", error_message: message })
    .eq("file_path", filePath)
    .eq("user_id", userId);
}

async function loadExistingVendorIdentityMap(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
) {
  const map = new Map<string, { id: string; normalizedName: string }>();
  const result = await admin.from("vendors").select("id,normalized_name").eq("user_id", userId);
  if (result.error || !result.data) return map;
  for (const row of result.data) {
    const normalized = String(row.normalized_name ?? "").trim();
    if (!normalized) continue;
    const key = buildVendorIdentityKey(normalized);
    if (!key || map.has(key)) continue;
    map.set(key, { id: String(row.id), normalizedName: normalized });
  }
  return map;
}

function dedupeByNormalizedVendor(source: VendorBlock[]) {
  const map = new Map<string, Array<{ start: number; end: number }>>();
  const displayName = new Map<string, string>();
  for (const block of source) {
    const key = normalizeVendorName(block.vendorName).toLowerCase();
    const current = map.get(key) ?? [];
    map.set(key, [...current, ...block.ranges]);
    displayName.set(key, normalizeVendorName(block.vendorName));
  }
  return [...map.entries()].map(([key, ranges]) => ({
    vendorName: displayName.get(key) ?? key,
    ranges: ranges.sort((a, b) => a.start - b.start),
  }));
}

function normalizeVendorName(source: string): string {
  const cleaned = source
    .replace(/^\s*(?:nro\.?\s*)?\d[\d\-./]*\s*[:\-]?\s*/i, "")
    .replace(/^\s*[a-z]{1,3}\d+\s*[:\-]?\s*/i, "")
    .replace(/\b\d{2}-\d{8}-\d\b/g, "")
    .replace(/\b\d{4,}\b/g, "")
    .replace(/\b(CUIT|COD)\b/gi, "")
    .replace(/^[\s,.-]+|[\s,.-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.includes(",")) {
    const [lastName, firstName] = cleaned
      .split(",")
      .map((part) => part.replace(/^[\s,.-]+|[\s,.-]+$/g, "").trim());
    if (lastName && firstName) return titleCase(`${firstName} ${lastName}`);
  }
  return titleCase(cleaned).replace(/[\s,.-]+$/g, "").trim();
}

function titleCase(value: string): string {
  const upperAcronyms = new Set(["sa", "srl", "sas", "s.a.", "s.r.l."]);
  return value
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((token) => {
      if (upperAcronyms.has(token)) return token.toUpperCase().replaceAll(".", "");
      return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
    })
    .join(" ")
    .trim();
}

function normalizeCompareText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildVendorIdentityKey(value: string) {
  const normalized = normalizeCompareText(normalizeVendorName(value));
  if (!normalized) return "";
  return normalized
    .split(" ")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join(" ");
}
