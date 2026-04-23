import { Buffer } from "node:buffer";

import JSZip from "jszip";

/**
 * Atributos OOXML que fuerzan: apaisado, A3, 1 página de ancho, alto libre.
 * Nota: `fitToHeight="0"` significa “no limitar alto”.
 */
const PAGE_SETUP_ATTRS =
  'paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0" usePrinterDefaults="0"';

/** Decora los sheet*.xml y workbook.xml para que Calc/LO ajuste ancho al imprimir. */
export async function patchXlsxForPdfFit(xlsx: Uint8Array): Promise<Buffer> {
  const zip = await JSZip.loadAsync(Buffer.from(xlsx));
  const sheetPaths = Object.keys(zip.files).filter(
    (p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p),
  );
  if (sheetPaths.length === 0) {
    return Buffer.from(xlsx);
  }

  for (const path of sheetPaths) {
    const file = zip.file(path);
    if (!file) continue;
    let xml = await file.async("string");

    // 1) Quitar saltos de columna manuales (eso es lo que rompía el ancho).
    xml = stripColBreaks(xml);
    // 2) Quitar fila de saltos de alto (ok dejar LO decidir; evita páginas extra).
    xml = stripRowBreaks(xml);
    // 3) Forzar fitToPage=1 en <sheetPr><pageSetUpPr/>
    xml = ensureSheetPrFitToPage(xml);
    // 4) Reemplazar <pageSetup .../> por uno que ajuste ancho (sin scale).
    xml = ensurePageSetup(xml);
    // 5) Márgenes angostos para aprovechar ancho.
    xml = ensureTightPageMargins(xml);

    zip.file(path, xml);
  }

  // workbook.xml: eliminar `_xlnm.Print_Area` (LO lo respeta y puede cortar columnas).
  const wbFile = zip.file("xl/workbook.xml");
  if (wbFile) {
    const xml = await wbFile.async("string");
    const cleaned = stripPrintAreaDefinedNames(xml);
    if (cleaned !== xml) {
      zip.file("xl/workbook.xml", cleaned);
    }
  }

  const out = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return Buffer.from(out);
}

function stripColBreaks(xml: string): string {
  return xml
    .replace(/<colBreaks\b[\s\S]*?<\/colBreaks>/g, "")
    .replace(/<colBreaks\b[^/>]*\/>/g, "");
}

function stripRowBreaks(xml: string): string {
  return xml
    .replace(/<rowBreaks\b[\s\S]*?<\/rowBreaks>/g, "")
    .replace(/<rowBreaks\b[^/>]*\/>/g, "");
}

function stripPrintAreaDefinedNames(workbookXml: string): string {
  if (!/<definedNames\b/.test(workbookXml)) {
    return workbookXml;
  }
  return workbookXml.replace(
    /<definedNames\b[^>]*>([\s\S]*?)<\/definedNames>/,
    (_m, inner: string) => {
      const cleaned = inner.replace(
        /<definedName\b[^>]*name=("|')_xlnm\.Print_Area\1[\s\S]*?<\/definedName>/g,
        "",
      );
      const trimmed = cleaned.trim();
      if (trimmed.length === 0) {
        return "";
      }
      return `<definedNames>${cleaned}</definedNames>`;
    },
  );
}

function ensureSheetPrFitToPage(xml: string): string {
  if (/<pageSetUpPr\s+[^>]*fitToPage="1"/.test(xml)) {
    return xml;
  }
  if (/<pageSetUpPr\b[^/]*\/>/.test(xml)) {
    return xml.replace(
      /<pageSetUpPr\b[^/]*\/>/,
      '<pageSetUpPr fitToPage="1"/>',
    );
  }
  if (/<sheetPr\b[^>]*>[\s\S]*?<\/sheetPr>/.test(xml)) {
    return xml.replace(
      /<sheetPr\b([^>]*)>([\s\S]*?)<\/sheetPr>/,
      (_m, attrs: string, inner: string) => {
        const cleaned = inner.replace(/<pageSetUpPr\b[^/]*\/?>(?:<\/pageSetUpPr>)?/g, "");
        return `<sheetPr${attrs}>${cleaned}<pageSetUpPr fitToPage="1"/></sheetPr>`;
      },
    );
  }
  if (/<sheetPr\b[^/]*\/>/.test(xml)) {
    return xml.replace(
      /<sheetPr\b([^/]*)\/>/,
      (_m, attrs: string) =>
        `<sheetPr${attrs}><pageSetUpPr fitToPage="1"/></sheetPr>`,
    );
  }
  return xml.replace(
    /<worksheet\b([^>]*)>/,
    (m, attrs: string) =>
      `<worksheet${attrs}><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`,
  ) || xml;
}

function ensurePageSetup(xml: string): string {
  if (/<pageSetup\b[^/>]*\/>/.test(xml) || /<pageSetup\b[\s\S]*?<\/pageSetup>/.test(xml)) {
    return xml.replace(
      /<pageSetup\b[^/>]*\/>|<pageSetup\b[\s\S]*?<\/pageSetup>/,
      `<pageSetup ${PAGE_SETUP_ATTRS}/>`,
    );
  }
  // insertar al final, antes de </worksheet>
  return xml.replace(
    /<\/worksheet>\s*$/,
    `<pageMargins left="0.3" right="0.3" top="0.35" bottom="0.35" header="0.2" footer="0.2"/><pageSetup ${PAGE_SETUP_ATTRS}/></worksheet>`,
  );
}

function ensureTightPageMargins(xml: string): string {
  if (/<pageMargins\b[^/>]*\/>/.test(xml)) {
    return xml.replace(
      /<pageMargins\b[^/>]*\/>/,
      '<pageMargins left="0.3" right="0.3" top="0.35" bottom="0.35" header="0.2" footer="0.2"/>',
    );
  }
  return xml;
}
