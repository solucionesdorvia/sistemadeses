import { basename } from "node:path";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "xlsx";

/** 1 pág. A4, solo texto (si todo lo demás revienta, igual queda un PDF). */
export async function minimalPdfError(message: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([595.28, 841.89]);
  p.drawText("No se pudo generar el PDF de la cuenta corriente.", {
    x: 48,
    y: 780,
    size: 12,
    font,
    color: rgb(0.2, 0, 0),
  });
  p.drawText(message, {
    x: 48,
    y: 750,
    size: 8,
    font,
    color: rgb(0.2, 0.2, 0.2),
    maxWidth: 500,
    lineHeight: 10,
  });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** A4 apaisada (pt), origen abajo-izquierda en pdf-lib */
const PAGE_W = 842.07;
const PAGE_H = 595.28;
const MARGIN = 36;

function truncateCell(s: string, max: number): string {
  const t = String(s).replace(/\r\n/g, " ").replace(/\s+/g, " ").trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Plan B local: si LibreOffice no corre o falla, genera un PDF legible con
 * la grilla de datos (no es fiel a Excel en estilos; siempre produce bytes).
 */
export async function xlsxToPdfFallback(
  data: Uint8Array,
  fileName: string,
  loErrorNote?: string,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const label = basename(fileName);

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, {
      type: "array",
      cellText: true,
      cellDates: true,
      raw: false,
    });
  } catch {
    const p = pdf.addPage([PAGE_W, PAGE_H]);
    p.drawText("No se pudo leer el archivo Excel (formato invalido o corrupto).", {
      x: MARGIN,
      y: PAGE_H - MARGIN - 14,
      size: 11,
      font,
      color: rgb(0.2, 0, 0),
      maxWidth: PAGE_W - 2 * MARGIN,
    });
    if (loErrorNote) {
      p.drawText(`Detalle: ${truncateCell(loErrorNote, 500)}`, {
        x: MARGIN,
        y: PAGE_H - MARGIN - 40,
        size: 8,
        font,
        color: rgb(0.3, 0.3, 0.3),
        maxWidth: PAGE_W - 2 * MARGIN,
      });
    }
    return Buffer.from(await pdf.save({ useObjectStreams: false }));
  }

  if (!wb.SheetNames.length) {
    const p = pdf.addPage([PAGE_W, PAGE_H]);
    p.drawText("El Excel no contiene hojas visibles.", {
      x: MARGIN,
      y: PAGE_H - MARGIN - 14,
      size: 11,
      font,
    });
    return Buffer.from(await pdf.save({ useObjectStreams: false }));
  }

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) {
      continue;
    }
    if (!sheet["!ref"]) {
      const p = pdf.addPage([PAGE_W, PAGE_H]);
      p.drawText(`Hoja "${sheetName}" sin celdas usadas.`, {
        x: MARGIN,
        y: PAGE_H - MARGIN - 14,
        size: 10,
        font,
      });
      continue;
    }

    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const colCount = range.e.c - range.s.c + 1;
    const rowCount = range.e.r - range.s.r + 1;
    const rows: string[][] = [];
    for (let r = range.s.r; r <= range.e.r; r += 1) {
      const row: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr] as { w?: string; v?: unknown } | undefined;
        let text = "";
        if (cell) {
          text =
            cell.w != null && String(cell.w).length > 0
              ? String(cell.w)
              : cell.v != null
                ? String(cell.v)
                : "";
        }
        row.push(text);
      }
      rows.push(row);
    }

    const title = `Cuenta corriente — ${sheetName} — ${label}`;
    const contentW = PAGE_W - 2 * MARGIN;

    // Ancho de columna proporcional al contenido real (max de cada columna).
    // Mínimo 24pt, así columnas con números cortos no roban espacio a las
    // columnas con nombres largos. Cap por columna: 40 % del ancho total.
    const maxLens = Array(colCount).fill(0) as number[];
    for (const row of rows) {
      for (let c = 0; c < colCount; c++) {
        maxLens[c] = Math.max(maxLens[c]!, (row[c] ?? "").length);
      }
    }
    const totalLen = maxLens.reduce((a, b) => a + Math.max(b, 3), 0) || 1;
    const rawColWidths = maxLens.map((len) =>
      Math.min((Math.max(len, 3) / totalLen) * contentW, contentW * 0.4),
    );
    // Normalizar para que sumen exactamente contentW.
    const rawSum = rawColWidths.reduce((a, b) => a + b, 0) || 1;
    const colWidths = rawColWidths.map((w) => (w / rawSum) * contentW);

    // Tamaño de fuente adaptado al ancho promedio de columna.
    const avgColW = contentW / Math.max(1, colCount);
    const size = Math.max(4.5, Math.min(8, avgColW / 3.2));
    const lineH = size * 1.45;
    const titleBlock = 32;
    const rowAreaH = PAGE_H - 2 * MARGIN - titleBlock;
    const rowsPerPage = Math.max(1, Math.floor(rowAreaH / lineH));

    let offset = 0;
    let part = 0;
    const pageParts = Math.max(1, Math.ceil(rowCount / rowsPerPage));
    while (offset < rowCount) {
      part += 1;
      const page = pdf.addPage([PAGE_W, PAGE_H]);
      let y = PAGE_H - MARGIN - 10;
      const head =
        rowCount > rowsPerPage
          ? `${title}  (parte ${part} de ${pageParts})`
          : title;
      page.drawText(truncateCell(head, 200), {
        x: MARGIN,
        y,
        size: 9,
        font: fontBold,
        color: rgb(0, 0, 0.35),
        maxWidth: contentW,
      });
      y -= titleBlock;
      const limit = Math.min(offset + rowsPerPage, rowCount);
      for (let ri = offset; ri < limit; ri += 1) {
        const row = rows[ri]!;
        let x = MARGIN;
        for (let c = 0; c < colCount; c += 1) {
          const cw = colWidths[c] ?? avgColW;
          // Cap de caracteres generoso: ~4 px/char a fuente size.
          const cap = Math.max(12, Math.floor(cw / (size * 0.52)));
          const t = truncateCell(String(row[c] ?? ""), cap);
          page.drawText(t, {
            x,
            y,
            size,
            font,
            color: rgb(0, 0, 0),
            maxWidth: cw - 2,
          });
          x += cw;
        }
        y -= lineH;
      }
      offset = limit;
    }
  }

  if (loErrorNote) {
    // Pagina extra dedicada al error completo: sin truncar con `…`, asi se
    // puede leer textual el motivo por el que LO rechaza el XLSX puntual.
    const errPage = pdf.addPage([PAGE_W, PAGE_H]);
    errPage.drawText("PDF de respaldo (tabla de datos): LibreOffice fallo.", {
      x: MARGIN,
      y: PAGE_H - MARGIN - 14,
      size: 12,
      font: fontBold,
      color: rgb(0.45, 0, 0),
    });
    errPage.drawText(
      "El contenido se renderizo con pdf-lib. Mensaje completo de LibreOffice abajo:",
      {
        x: MARGIN,
        y: PAGE_H - MARGIN - 32,
        size: 9,
        font,
        color: rgb(0.2, 0.2, 0.2),
        maxWidth: PAGE_W - 2 * MARGIN,
      },
    );
    const cleanedNote = loErrorNote.replace(/\s+/g, " ").trim();
    errPage.drawText(cleanedNote, {
      x: MARGIN,
      y: PAGE_H - MARGIN - 56,
      size: 8,
      font,
      color: rgb(0.1, 0.1, 0.1),
      maxWidth: PAGE_W - 2 * MARGIN,
      lineHeight: 11,
    });
  }

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
