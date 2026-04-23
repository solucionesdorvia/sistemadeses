import { Buffer } from "node:buffer";

import JSZip from "jszip";

/**
 * Atributos OOXML que fuerzan: apaisado, A3, 1 página de ancho, alto libre.
 * Nota: `fitToHeight="0"` significa “no limitar alto”.
 */
const PAGE_SETUP_ATTRS =
  'paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0" usePrinterDefaults="0"';

/** Decora los sheet*.xml para que Calc/LO ajuste ancho al imprimir. */
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

    // 1) <sheetPr ...><pageSetUpPr fitToPage="1"/></sheetPr> (fuerza “ajustar”)
    xml = ensureSheetPrFitToPage(xml);

    // 2) <pageSetup .../> con los atributos que nos interesan
    xml = ensurePageSetup(xml);

    // 3) <pageMargins .../> mínimos (mejora el aprovechamiento del ancho)
    xml = ensureTightPageMargins(xml);

    zip.file(path, xml);
  }

  const out = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return Buffer.from(out);
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
