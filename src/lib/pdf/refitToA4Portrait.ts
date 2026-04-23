import { PDFDocument } from "pdf-lib";

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 0.98;

/**
 * Toma el PDF de LibreOffice y lo recompone a A4 vertical.
 * Recorta la porción **izquierda** de la hoja (donde está la grilla) para no
 * escalar el blanco a la derecha, que hacía letra chica e “hoja vacía” al costado.
 */
export async function refitPdfToA4Portrait(pdfBytes: Buffer): Promise<Buffer> {
  try {
    const source = await PDFDocument.load(Uint8Array.from(pdfBytes), {
      ignoreEncryption: true,
    });
    const n = source.getPageCount();
    if (n === 0) return pdfBytes;

    const out = await PDFDocument.create();

    for (let i = 0; i < n; i += 1) {
      const srcPage = source.getPage(i);
      const w = srcPage.getWidth();
      const h = srcPage.getHeight();
      // Hojas anchas (A2/landscape o LO con mucho aire a la derecha): quedarnos con ~70% ancho; A4 raso: suavizar
      const widePage = w > 620;
      const clipRatio = widePage ? 0.7 : 0.9;
      const clipW = w * clipRatio;
      const embedded = await out.embedPage(srcPage, {
        left: 0,
        right: clipW,
        bottom: 0,
        top: h,
      });
      const ew = embedded.width;
      const eh = embedded.height;
      const page = out.addPage([A4_W, A4_H]);
      const scale = Math.min((A4_W * MARGIN) / ew, (A4_H * MARGIN) / eh);
      const dw = ew * scale;
      const dh = eh * scale;
      const x = (A4_W - dw) / 2;
      const y = (A4_H - dh) / 2;
      page.drawPage(embedded, { x, y, width: dw, height: dh });
    }

    const saved = await out.save({ useObjectStreams: false });
    return Buffer.from(saved);
  } catch (err) {
    console.error("[refitPdfToA4Portrait] fallo, se devuelve PDF original", err);
    return pdfBytes;
  }
}
