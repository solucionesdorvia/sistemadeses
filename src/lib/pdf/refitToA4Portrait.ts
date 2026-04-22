import { PDFDocument } from "pdf-lib";

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 0.98;

/**
 * Toma el PDF que sale de LibreOffice (A2, apaisado, distintos márgenes) y lo
 * recompone a **A4 vertical** encajando y escalando el contenido de cada página.
 * Así el resultado no depende de que Calc respete el `pageSetup` del xlsx.
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
      const [embedded] = await out.embedPdf(pdfBytes, [i]);
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
