import { PDFDocument } from "pdf-lib";

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 0.98;

/**
 * Toma el PDF de LibreOffice y lo recompone a A4 vertical.
 * Solo recortamos ancho a la derecha en **hojas muy anchas** (A2, apaisada con
 * franja blanca). En A4 ya “normal” (ancho ~595 pt) **no** recortamos: si no,
 * se manda mal la hoja (se cortan importes o columnas a la derecha).
 */
function clipWidthRatio(w: number, h: number): number {
  const portrait = h >= w * 0.99;
  const a4LikeW = w >= 560 && w <= 630;
  if (portrait && a4LikeW) {
    return 1;
  }
  if (w > 1100) {
    return 0.7;
  }
  if (w > 800) {
    return 0.78;
  }
  if (w > 700) {
    return 0.9;
  }
  return 1;
}

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
      const ratio = clipWidthRatio(w, h);
      const clipW = w * ratio;
      const embedded =
        ratio >= 0.999
          ? await out.embedPage(srcPage)
          : await out.embedPage(srcPage, {
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
