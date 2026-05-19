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

/** A4 apaisada (pt) — para páginas de error y hojas angostas */
const PAGE_W = 842.07;
const PAGE_H = 595.28;
/** A3 apaisada (pt) — para hojas con muchas columnas */
const PAGE_W_A3 = 1190.55;
const PAGE_H_A3 = 841.89;
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

    // A3 apaisado para hojas con muchas columnas, A4 para pocas.
    const isWide = colCount > 6;
    const CW = isWide ? PAGE_W_A3 : PAGE_W;
    const CH = isWide ? PAGE_H_A3 : PAGE_H;
    const contentW = CW - 2 * MARGIN;

    // Anchos de columna proporcionales al contenido real de cada columna.
    // Cap por columna: 42 % del ancho total para evitar que una columna
    // con texto muy largo consuma toda la página.
    const maxLens = Array(colCount).fill(0) as number[];
    for (const row of rows) {
      for (let c = 0; c < colCount; c++) {
        maxLens[c] = Math.max(maxLens[c]!, (row[c] ?? "").length);
      }
    }
    const totalLenRaw = maxLens.reduce((a, b) => a + Math.max(b, 3), 0) || 1;
    const rawWidths = maxLens.map((len) =>
      Math.min((Math.max(len, 3) / totalLenRaw) * contentW, contentW * 0.42),
    );
    const rawSum = rawWidths.reduce((a, b) => a + b, 0) || 1;
    const colWidths = rawWidths.map((w) => (w / rawSum) * contentW);

    const avgColW = contentW / Math.max(1, colCount);
    const size = Math.max(5, Math.min(8, avgColW / 2.8));
    const ROW_H = size * 2.1;
    const TITLE_BLOCK = 28;
    const rowAreaH = CH - 2 * MARGIN - TITLE_BLOCK;
    const rowsPerPage = Math.max(1, Math.floor(rowAreaH / ROW_H));

    const WHITE = rgb(1, 1, 1);
    const CELL_BORDER = rgb(0.72, 0.72, 0.72);
    const TEXT_COL = rgb(0, 0, 0);

    let offset = 0;
    let part = 0;
    const pageParts = Math.max(1, Math.ceil(rowCount / rowsPerPage));
    while (offset < rowCount) {
      part += 1;
      const page = pdf.addPage([CW, CH]);
      const head =
        rowCount > rowsPerPage
          ? `${title}  (parte ${part} de ${pageParts})`
          : title;
      page.drawText(truncateCell(head, 200), {
        x: MARGIN,
        y: CH - MARGIN - 10,
        size: 9,
        font: fontBold,
        color: rgb(0, 0, 0.35),
        maxWidth: contentW,
      });

      const startY = CH - MARGIN - TITLE_BLOCK;
      const limit = Math.min(offset + rowsPerPage, rowCount);

      for (let ri = offset; ri < limit; ri += 1) {
        const localIdx = ri - offset;
        const rowBottom = startY - (localIdx + 1) * ROW_H;
        // Baseline de texto a ~30 % de la altura de la fila desde abajo.
        const textY = rowBottom + ROW_H * 0.3;

        const isHeaderRow = ri === range.s.r;

        let x = MARGIN;
        for (let c = 0; c < colCount; c += 1) {
          const cw = colWidths[c] ?? avgColW;
          const raw = String(rows[ri]![c] ?? "");
          const cap = Math.max(14, Math.floor(cw / (size * 0.52)));
          const t = truncateCell(raw, cap);

          // Celda: fondo blanco + borde gris
          page.drawRectangle({
            x,
            y: rowBottom,
            width: cw,
            height: ROW_H,
            color: WHITE,
            borderColor: CELL_BORDER,
            borderWidth: 0.35,
          });

          // Alinear números a la derecha
          const isNum =
            !isHeaderRow &&
            raw.trim() !== "" &&
            /^-?[\d.,\s]+$/.test(raw.trim());
          let textX = x + 3;
          if (isNum) {
            try {
              const tw = font.widthOfTextAtSize(t, size);
              textX = x + cw - 4 - tw;
            } catch {
              textX = x + cw - 4 - t.length * size * 0.5;
            }
          }

          page.drawText(t, {
            x: Math.max(x + 2, Math.min(textX, x + cw - 3)),
            y: textY,
            size,
            font: isHeaderRow ? fontBold : font,
            color: TEXT_COL,
            maxWidth: cw - 5,
          });

          x += cw;
        }
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
