import { createClient } from "npm:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";
import JSZip from "npm:jszip@3.10.1";

import { corsHeaders } from "../_shared/cors.ts";
import { getRequestUserId } from "../_shared/auth.ts";
import {
  normalizeVendorName,
  pathSafeVendorName,
} from "../_shared/vendor-normalization.ts";

type RequestBody = {
  companyType: "americana" | "days" | "desesplast";
  filePaths: string[];
  skipCleanup?: boolean;
  syncAfterProcess?: boolean;
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const userId = await getRequestUserId(request);
    const body = (await request.json()) as RequestBody;
    if (!body.filePaths?.length) {
      return jsonError("No se recibieron archivos para procesar.", 400);
    }

    // Limpieza inicial por empresa. Puede omitirse para archivos siguientes del mismo lote.
    if (!body.skipCleanup) {
      await cleanupCompanyResults(userId, body.companyType);
    }

    const processedVendors = new Set<string>();
    const vendorIdentityMap = await loadExistingVendorIdentityMap(userId);

    for (const filePath of body.filePaths) {
      const fileRow = await supabase
        .from("files")
        .select("id,user_id")
        .eq("file_path", filePath)
        .eq("user_id", userId)
        .single();

      if (fileRow.error || !fileRow.data) {
        await markFileAsError(userId, filePath, "No se encontro registro del archivo.");
        continue;
      }
      const fileId = fileRow.data.id;

      const downloaded = await supabase.storage.from("uploads").download(filePath);
      if (downloaded.error || !downloaded.data) {
        await markFileAsError(
          userId,
          filePath,
          downloaded.error?.message ?? "No se pudo descargar.",
        );
        continue;
      }

      const sourceArrayBuffer = await downloaded.data.arrayBuffer();
      if (!filePath.toLowerCase().endsWith(".xlsx")) {
        await markFileAsError(
          userId,
          filePath,
          "Formato no soportado en servidor. La conversion .xls->.xlsx debe ocurrir en cliente.",
        );
        continue;
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
      if (!sheet) {
        await markFileAsError(userId, filePath, "No se pudo leer la hoja principal del archivo.");
        continue;
      }
      const sourceWorksheetMeta = await extractSourceWorksheetMeta(sourceArrayBuffer);
      if (!sourceWorksheetMeta?.worksheetXml) {
        await markFileAsError(
          userId,
          filePath,
          "No se pudo leer metadata OOXML del archivo convertido a .xlsx.",
        );
        continue;
      }

      const literalCropContext = await createLiteralCropContext(sourceArrayBuffer);

      const blocks = detectVendorBlocks(sheet, body.companyType);
      let vendorsFoundCount = 0;
      for (const block of blocks) {
        if (!block.vendorName || block.ranges.length === 0) continue;
        const normalized = normalizeVendorName(block.vendorName);
        if (!normalized) continue;
        const identityKey = buildVendorIdentityKey(normalized);
        const existingVendor = vendorIdentityMap.get(identityKey);
        const canonicalNormalized =
          existingVendor?.normalizedName ?? normalized;
        const safeName = pathSafeVendorName(canonicalNormalized);

        const patched = await cropXlsxWorkbookFromContext(literalCropContext, block.ranges);
        const outputPath = `${userId}/vendedores/${safeName}/${canonicalNormalized}_${body.companyType}.xlsx`;

        const uploadResult = await supabase.storage
          .from("results")
          .upload(outputPath, patched, { upsert: true });

        if (uploadResult.error) {
          throw new Error(uploadResult.error.message);
        }

        if (existingVendor) {
          const vendorUpdate = await supabase
            .from("vendors")
            .update({
              original_name: block.vendorName,
            })
            .eq("id", existingVendor.id);
          if (vendorUpdate.error) throw new Error(vendorUpdate.error.message);
        } else {
          const vendorInsert = await supabase
            .from("vendors")
            .insert({
              user_id: userId,
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

      await markFileAsCompleted(userId, fileId, filePath, vendorsFoundCount);
    }

    // Google Drive es opcional. Si falla o esta desactivado, no debe romper
    // el procesamiento principal de cuentas corrientes.
    const enableDriveSync =
      body.syncAfterProcess === true &&
      Deno.env.get("ENABLE_GOOGLE_DRIVE_SYNC")?.toLowerCase() === "true";
    if (enableDriveSync) {
      try {
        await supabase.functions.invoke("sync-google-drive", {
          body: {},
          headers: {
            Authorization: request.headers.get("Authorization") ?? "",
            "x-user-jwt": request.headers.get("x-user-jwt") ?? "",
          },
        });
      } catch {
        // Silencioso por diseno: el core es procesar XLSX.
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        processedVendors: Array.from(processedVendors),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Error al procesar cuentas corrientes.",
      500,
    );
  }
});

function detectVendorBlocks(
  sheet: XLSX.WorkSheet,
  companyType: RequestBody["companyType"],
) {
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);

  const markers = new Map<number, string>();
  const regex = /vendedor\s*:\s*([a-z0-9 ,.'-]+)/i;

  if (companyType === "americana") {
    // Americana: mantener deteccion estricta por merged cells A:I.
    const merges = sheet["!merges"] ?? [];
    for (const merge of merges) {
      const span = merge.e.c - merge.s.c + 1;
      if (merge.s.c === 0 && span >= 9) {
        const address = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
        const value = String(sheet[address]?.v ?? "");
        const match = value.match(regex);
        if (match?.[1]) {
          markers.set(merge.s.r, match[1].trim());
        }
      }
    }

    // Fallback defensivo: algunos archivos pueden no traer merges consistentes.
    // En ese caso, detectamos por texto "Vendedor:" en toda la fila.
    if (markers.size === 0) {
      for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
        const asText = readRowText(sheet, rowIndex, 0, 30);
        const match = asText.match(regex);
        if (match?.[1]) {
          markers.set(rowIndex, match[1].trim());
        }
      }
    }
  } else {
    // Days/Desesplast: escaneo textual C:AE
    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
      const asText = readRowText(sheet, rowIndex, 2, 30);
      const match = asText.match(regex);
      if (match?.[1]) {
        markers.set(rowIndex, match[1].trim());
      }
    }
  }

  const sorted = [...markers.entries()].sort((a, b) => a[0] - b[0]);
  const blocks: Array<{ vendorName: string; ranges: Array<{ start: number; end: number }> }> =
    [];

  sorted.forEach(([startRow, name], index) => {
    const nextStart = sorted[index + 1]?.[0] ?? range.e.r + 1;
    let endRow = Math.max(startRow, nextStart - 1);

    if (companyType !== "americana") {
      const totalRow = findVendorTotalRow(sheet, startRow, endRow, name);
      if (totalRow !== null) {
        endRow = totalRow;
      }
    }

    if (endRow >= startRow) {
      blocks.push({
        vendorName: name,
        ranges: [{ start: startRow, end: endRow }],
      });
    }
  });

  return dedupeByNormalizedVendor(blocks);
}

function readRowText(
  sheet: XLSX.WorkSheet,
  rowIndex: number,
  fromCol: number,
  toCol: number,
) {
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
    // En Days/Desesplast el "Total <vendedor>" suele venir en columnas A/B.
    const rowText = normalizeCompareText(readRowText(sheet, rowIndex, 0, 30));
    if (!rowText.startsWith("total")) continue;

    if (rowText.includes(normalizedVendor)) {
      return rowIndex;
    }

    const tokenMatches = tokens.filter((token) => rowText.includes(token)).length;
    if (tokens.length > 0 && tokenMatches >= Math.max(1, tokens.length - 1)) {
      return rowIndex;
    }
  }

  return null;
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

async function loadExistingVendorIdentityMap(userId: string) {
  const map = new Map<string, { id: string; normalizedName: string }>();
  const result = await supabase
    .from("vendors")
    .select("id,normalized_name")
    .eq("user_id", userId);

  if (result.error || !result.data) return map;

  for (const row of result.data) {
    const normalized = String(row.normalized_name ?? "").trim();
    if (!normalized) continue;
    const key = buildVendorIdentityKey(normalized);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        id: String(row.id),
        normalizedName: normalized,
      });
    }
  }

  return map;
}


function dedupeByNormalizedVendor(
  source: Array<{ vendorName: string; ranges: Array<{ start: number; end: number }> }>,
) {
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

function buildVendorSheet(
  sourceSheet: XLSX.WorkSheet,
  ranges: Array<{ start: number; end: number }>,
): XLSX.WorkSheet {
  const ref = sourceSheet["!ref"];
  if (!ref) return XLSX.utils.aoa_to_sheet([]);

  const sourceRange = XLSX.utils.decode_range(ref);
  const targetSheet: XLSX.WorkSheet = {};
  const rowMap = new Map<number, number>();
  let targetRow = 0;

  for (const range of ranges) {
    for (let r = range.start; r <= range.end; r += 1) {
      rowMap.set(r, targetRow);
      for (let c = sourceRange.s.c; c <= sourceRange.e.c; c += 1) {
        const sourceAddr = XLSX.utils.encode_cell({ r, c });
        const cell = sourceSheet[sourceAddr];
        if (!cell) continue;
        const targetAddr = XLSX.utils.encode_cell({ r: targetRow, c });
        targetSheet[targetAddr] = { ...cell };
      }
      targetRow += 1;
    }
  }

  if (targetRow === 0) return XLSX.utils.aoa_to_sheet([]);

  targetSheet["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: sourceRange.s.c },
    e: { r: targetRow - 1, c: sourceRange.e.c },
  });

  if (sourceSheet["!cols"]) {
    targetSheet["!cols"] = sourceSheet["!cols"].map((col) => ({ ...col }));
  }

  if (sourceSheet["!rows"]) {
    targetSheet["!rows"] = [];
    for (const [sourceRow, mappedRow] of rowMap.entries()) {
      const rowMeta = sourceSheet["!rows"]?.[sourceRow];
      if (rowMeta) {
        targetSheet["!rows"][mappedRow] = { ...rowMeta };
      }
    }
  }

  if (sourceSheet["!merges"]) {
    const merges: XLSX.Range[] = [];
    for (const merge of sourceSheet["!merges"]) {
      const startMapped = rowMap.get(merge.s.r);
      const endMapped = rowMap.get(merge.e.r);
      if (startMapped === undefined || endMapped === undefined) continue;
      if (endMapped < startMapped) continue;
      merges.push({
        s: { r: startMapped, c: merge.s.c },
        e: { r: endMapped, c: merge.e.c },
      });
    }
    if (merges.length > 0) {
      targetSheet["!merges"] = merges;
    }
  }

  copySheetLevelMeta(sourceSheet, targetSheet);

  return targetSheet;
}

async function cropXlsxWorkbookFromSource(
  sourceWorkbookBuffer: ArrayBuffer,
  ranges: Array<{ start: number; end: number }>,
) {
  const context = await createLiteralCropContext(sourceWorkbookBuffer);
  return await cropXlsxWorkbookFromContext(context, ranges);
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
  if (!worksheetFile) {
    throw new Error("No se encontro worksheet en el archivo XLSX.");
  }
  const sourceWorksheetXml = await worksheetFile.async("text");
  return {
    zip,
    worksheetPath,
    sourceWorksheetXml,
  };
}

async function cropXlsxWorkbookFromContext(
  context: LiteralCropContext,
  ranges: Array<{ start: number; end: number }>,
) {
  const croppedWorksheetXml = cropWorksheetXmlByRanges(context.sourceWorksheetXml, ranges);
  context.zip.file(context.worksheetPath, croppedWorksheetXml);
  const out = await context.zip.generateAsync({ type: "uint8array" });
  // Restaura XML base para el siguiente vendedor.
  context.zip.file(context.worksheetPath, context.sourceWorksheetXml);
  return out;
}

function cropWorksheetXmlByRanges(
  worksheetXml: string,
  ranges: Array<{ start: number; end: number }>,
) {
  const normalizedRanges = ranges
    .map((range) => ({ start: range.start + 1, end: range.end + 1 }))
    .sort((a, b) => a.start - b.start);

  const inRange = (row: number) =>
    normalizedRanges.some((range) => row >= range.start && row <= range.end);

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
    const remappedRow = remapRowBlock(rowBlock, sourceRow, nextRow);
    keptRows.push(remappedRow);
    nextRow += 1;
  }

  let updatedXml = worksheetXml.replace(
    sheetDataRegex,
    `<sheetData>${keptRows.join("")}</sheetData>`,
  );
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
  if (/\b r="\d+"/.test(updated)) {
    updated = updated.replace(/\b r="\d+"/, ` r="${toRow}"`);
  } else {
    updated = updated.replace("<row", `<row r="${toRow}"`);
  }

  // Remapea referencias de celda dentro de la fila recortada.
  updated = updated.replace(/\br="([A-Z]+)(\d+)"/g, (_full, col, row) => {
    const numericRow = Number(row);
    if (numericRow !== fromRow) return `r="${col}${row}"`;
    return `r="${col}${toRow}"`;
  });

  // Remapea refs de formulas compartidas/arrays que incluyan filas.
  updated = updated.replace(/\bref="([A-Z]+\d+:[A-Z]+\d+)"/g, (_full, ref) => {
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

    const mappedRef = `${start.col}${mappedStart}:${end.col}${mappedEnd}`;
    remappedMergeTags.push(`<mergeCell ref="${mappedRef}"/>`);
  }

  if (remappedMergeTags.length === 0) {
    return worksheetXml.replace(mergeBlockRegex, "");
  }

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
    // fallback seguro
  }

  const nextRef = `${colStart}${minRow + 1}:${colEnd}${maxRow + 1}`;
  return worksheetXml.replace(
    /<dimension\b[^>]*\bref="[^"]+"[^>]*\/>/,
    `<dimension ref="${nextRef}"/>`,
  );
}

function decodeCellRef(ref: string) {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match?.[1] || !match[2]) return null;
  return {
    col: match[1],
    row: Number(match[2]),
  };
}

function shiftRangeRefByOffset(ref: string, offset: number) {
  const [start, end = start] = ref.split(":");
  const shiftedStart = shiftCellRefByOffset(start, offset);
  const shiftedEnd = shiftCellRefByOffset(end, offset);
  return `${shiftedStart}:${shiftedEnd}`;
}

function shiftCellRefByOffset(ref: string, offset: number) {
  const parsed = decodeCellRef(ref);
  if (!parsed) return ref;
  return `${parsed.col}${Math.max(1, parsed.row + offset)}`;
}

type SourceWorksheetMeta = {
  colsXml: string | null;
  worksheetXml: string | null;
  workbookXml: string | null;
};

async function extractSourceWorksheetMeta(
  sourceWorkbookBuffer: ArrayBuffer,
): Promise<SourceWorksheetMeta | null> {
  try {
    const sourceZip = await JSZip.loadAsync(sourceWorkbookBuffer);
    const worksheetPath = await resolveFirstWorksheetPath(sourceZip);
    const sourceWorksheet = sourceZip.file(worksheetPath);
    if (!sourceWorksheet) return null;
    const worksheetXml = await sourceWorksheet.async("text");
    const workbookXml = await sourceZip.file("xl/workbook.xml")?.async("text");
    const colsMatch = worksheetXml.match(/<cols>[\s\S]*?<\/cols>/);
    return {
      colsXml: colsMatch?.[0] ?? null,
      worksheetXml,
      workbookXml: workbookXml ?? null,
    };
  } catch {
    // Archivos .xls no son ZIP/OOXML. En ese caso se usa metadata de SheetJS.
    return null;
  }
}

async function patchWorkbookXml(
  workbookBuffer: ArrayBuffer,
  sourceColsXml: string | null,
  sourceWorksheetXml: string | null,
  sourceWorkbookXml: string | null,
): Promise<Uint8Array> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(workbookBuffer);
  } catch {
    return new Uint8Array(workbookBuffer);
  }

  const worksheet = zip.file("xl/worksheets/sheet1.xml");
  if (!worksheet) {
    return new Uint8Array(workbookBuffer);
  }
  let patched = await worksheet.async("text");

  // Inyecta anchos de columna del archivo base para evitar recortes visuales.
  if (sourceColsXml) {
    if (patched.includes("<cols>")) {
      patched = patched.replace(/<cols>[\s\S]*?<\/cols>/, sourceColsXml);
    } else {
      patched = patched.replace(/(<sheetData>)/, `${sourceColsXml}$1`);
    }
  }

  // Preserva metadatos visuales del sheet original (zoom, vista, print setup, etc).
  if (sourceWorksheetXml) {
    patched = preserveWorksheetLayoutMeta(patched, sourceWorksheetXml);
  }
  zip.file("xl/worksheets/sheet1.xml", patched);

  if (sourceWorkbookXml) {
    const workbookFile = zip.file("xl/workbook.xml");
    if (workbookFile) {
      const currentWorkbookXml = await workbookFile.async("text");
      const patchedWorkbookXml = preserveWorkbookLayoutMeta(
        currentWorkbookXml,
        sourceWorkbookXml,
      );
      zip.file("xl/workbook.xml", patchedWorkbookXml);
    }
  }

  return await zip.generateAsync({ type: "uint8array" });
}

function preserveWorksheetLayoutMeta(targetXml: string, sourceXml: string) {
  const tagsToPreserve = [
    "sheetPr",
    "sheetViews",
    "sheetFormatPr",
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "rowBreaks",
    "colBreaks",
  ];

  let output = targetXml;
  for (const tag of tagsToPreserve) {
    output = replaceWorksheetTag(output, sourceXml, tag);
  }

  return output;
}

function replaceWorksheetTag(targetXml: string, sourceXml: string, tagName: string) {
  const sourceTag = extractWorksheetTag(sourceXml, tagName);
  if (!sourceTag) return targetXml;

  const targetRegex = new RegExp(
    `<${tagName}\\b[\\s\\S]*?<\\/${tagName}>|<${tagName}\\b[^>]*/>`,
  );
  if (targetRegex.test(targetXml)) {
    return targetXml.replace(targetRegex, sourceTag);
  }

  return targetXml.replace("</worksheet>", `${sourceTag}</worksheet>`);
}

function extractWorksheetTag(xml: string, tagName: string) {
  const blockRegex = new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`);
  const blockMatch = xml.match(blockRegex);
  if (blockMatch?.[0]) return blockMatch[0];

  const selfClosingRegex = new RegExp(`<${tagName}\\b[^>]*/>`);
  const selfClosingMatch = xml.match(selfClosingRegex);
  return selfClosingMatch?.[0] ?? null;
}

function preserveWorkbookLayoutMeta(targetXml: string, sourceXml: string) {
  const tagsToPreserve = ["workbookPr", "bookViews", "calcPr"];
  let output = targetXml;
  for (const tag of tagsToPreserve) {
    output = replaceWorkbookTag(output, sourceXml, tag);
  }
  return output;
}

function replaceWorkbookTag(targetXml: string, sourceXml: string, tagName: string) {
  const sourceTag = extractWorkbookTag(sourceXml, tagName);
  if (!sourceTag) return targetXml;

  const targetRegex = new RegExp(
    `<${tagName}\\b[\\s\\S]*?<\\/${tagName}>|<${tagName}\\b[^>]*/>`,
  );
  if (targetRegex.test(targetXml)) {
    return targetXml.replace(targetRegex, sourceTag);
  }

  return targetXml.replace("</workbook>", `${sourceTag}</workbook>`);
}

function extractWorkbookTag(xml: string, tagName: string) {
  const blockRegex = new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`);
  const blockMatch = xml.match(blockRegex);
  if (blockMatch?.[0]) return blockMatch[0];

  const selfClosingRegex = new RegExp(`<${tagName}\\b[^>]*/>`);
  const selfClosingMatch = xml.match(selfClosingRegex);
  return selfClosingMatch?.[0] ?? null;
}

function copySheetLevelMeta(sourceSheet: XLSX.WorkSheet, targetSheet: XLSX.WorkSheet) {
  const passthroughKeys = [
    "!autofilter",
    "!margins",
    "!outline",
    "!protect",
    "!sheetViews",
    "!pageSetup",
    "!printHeader",
    "!printFooter",
  ] as const;

  for (const key of passthroughKeys) {
    const value = sourceSheet[key];
    if (!value) continue;
    targetSheet[key] = cloneMeta(value);
  }
}

function cloneMeta<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function resolveFirstWorksheetPath(zip: JSZip) {
  const workbookXml = await zip.file("xl/workbook.xml")?.async("text");
  const workbookRelsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("text");
  if (!workbookXml || !workbookRelsXml) {
    return "xl/worksheets/sheet1.xml";
  }

  const firstSheetMatch = workbookXml.match(/<sheet\b[^>]*r:id="([^"]+)"[^>]*>/i);
  const firstRelId = firstSheetMatch?.[1];
  if (!firstRelId) {
    return "xl/worksheets/sheet1.xml";
  }

  const relRegex = new RegExp(
    `<Relationship\\b[^>]*Id="${firstRelId}"[^>]*Target="([^"]+)"[^>]*/?>`,
    "i",
  );
  const relMatch = workbookRelsXml.match(relRegex);
  const target = relMatch?.[1];
  if (!target) {
    return "xl/worksheets/sheet1.xml";
  }

  const normalizedTarget = target.replace(/^\/+/, "");
  if (normalizedTarget.startsWith("xl/")) return normalizedTarget;
  return `xl/${normalizedTarget}`;
}

async function cleanupCompanyResults(
  userId: string,
  companyType: RequestBody["companyType"],
) {
  const root = await supabase.storage.from("results").list(`${userId}/vendedores`, {
    limit: 1000,
  });
  if (root.error || !root.data) return;

  const toRemove: string[] = [];
  for (const entry of root.data) {
    const folderPath = `${userId}/vendedores/${entry.name}`;
    const nested = await supabase.storage.from("results").list(folderPath, { limit: 1000 });
    if (nested.error || !nested.data) continue;
    nested.data.forEach((item) => {
      if (item.name.endsWith(`_${companyType}.xlsx`)) {
        toRemove.push(`${folderPath}/${item.name}`);
      }
    });
  }

  if (toRemove.length > 0) {
    await supabase.storage.from("results").remove(toRemove);
  }
}

async function markFileAsCompleted(
  userId: string,
  fileId: string,
  filePath: string,
  vendorsFoundCount: number,
) {
  await supabase
    .from("files")
    .update({ status: "completed" })
    .eq("file_path", filePath)
    .eq("user_id", userId);

  const processInsert = await supabase
    .from("processes")
    .insert({
      user_id: userId,
      file_id: fileId,
      records_processed: vendorsFoundCount,
    });
  if (processInsert.error) {
    throw new Error(processInsert.error.message);
  }
}

async function markFileAsError(userId: string, filePath: string, message: string) {
  await supabase
    .from("files")
    .update({ status: "error", error_message: message })
    .eq("file_path", filePath)
    .eq("user_id", userId);
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
