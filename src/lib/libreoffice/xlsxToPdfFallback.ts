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
    const merges = (sheet["!merges"] ?? []) as XLSX.Range[];

    // Una "celda visual" es lo que el usuario ve en Excel: cualquier merge
    // (B5:F5 → un solo bloque ancho con su texto) o cualquier celda suelta
    // con contenido. Trabajar con spans en vez de celdas crudas es lo que
    // evita el problema de Desesplast: ~50 columnas estrechas con merges
    // todos los renglones renderizadas individualmente truncan a 1 char.
    type Span = { startCol: number; endCol: number; text: string };
    const rowSpans: Span[][] = [];
    const startColSet = new Set<number>();

    const readCellText = (r: number, c: number) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr] as { w?: string; v?: unknown } | undefined;
      if (!cell) return "";
      if (cell.w != null && String(cell.w).length > 0) return String(cell.w);
      if (cell.v != null) return String(cell.v);
      return "";
    };

    for (let r = range.s.r; r <= range.e.r; r += 1) {
      const spans: Span[] = [];
      const consumed = new Set<number>();
      for (const m of merges) {
        if (m.s.r !== r) continue;
        const text = readCellText(m.s.r, m.s.c);
        spans.push({ startCol: m.s.c, endCol: m.e.c, text });
        for (let c = m.s.c; c <= m.e.c; c += 1) consumed.add(c);
      }
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        if (consumed.has(c)) continue;
        const text = readCellText(r, c);
        if (text.trim()) spans.push({ startCol: c, endCol: c, text });
      }
      spans.sort((a, b) => a.startCol - b.startCol);
      for (const sp of spans) {
        if (sp.text.trim()) startColSet.add(sp.startCol);
      }
      rowSpans.push(spans);
    }

    const title = `Cuenta corriente — ${sheetName} — ${label}`;
    const gridCols = [...startColSet].sort((a, b) => a - b);

    // Si no hay merges relevantes ni datos en cols separadas, no podemos
    // armar una grilla útil — saltar al render plano por celdas.
    if (gridCols.length < 2) {
      const p = pdf.addPage([PAGE_W, PAGE_H]);
      p.drawText(title, {
        x: MARGIN,
        y: PAGE_H - MARGIN - 14,
        size: 11,
        font: fontBold,
        color: rgb(0, 0, 0.35),
        maxWidth: PAGE_W - 2 * MARGIN,
      });
      let yCursor = PAGE_H - MARGIN - 38;
      for (const spans of rowSpans) {
        if (yCursor < MARGIN + 12) break;
        const line = spans.map((s) => s.text).join("  ");
        if (line.trim()) {
          p.drawText(truncateCell(line, 200), { x: MARGIN, y: yCursor, size: 8, font });
        }
        yCursor -= 12;
      }
      continue;
    }

    const isWide = gridCols.length > 5;
    const CW = isWide ? PAGE_W_A3 : PAGE_W;
    const CH = isWide ? PAGE_H_A3 : PAGE_H;
    const contentW = CW - 2 * MARGIN;

    // Ancho por columna de la grilla: proporcional al texto mas largo
    // observado en cualquier span que arranca alli (cap 42 % por columna).
    const colMaxLen = new Map<number, number>();
    for (const spans of rowSpans) {
      for (const sp of spans) {
        const prev = colMaxLen.get(sp.startCol) ?? 0;
        colMaxLen.set(sp.startCol, Math.max(prev, sp.text.length));
      }
    }
    const lens = gridCols.map((g) => Math.max(colMaxLen.get(g) ?? 0, 4));
    const totalLen = lens.reduce((a, b) => a + b, 0) || 1;
    const rawWidths = lens.map((l) => Math.min((l / totalLen) * contentW, contentW * 0.42));
    const rawSum = rawWidths.reduce((a, b) => a + b, 0) || 1;
    const colWidths = rawWidths.map((w) => (w / rawSum) * contentW);

    // Map startCol -> { xOffset, defaultWidth } para localizar spans.
    const colXOffset = new Map<number, number>();
    const colWidthByStart = new Map<number, number>();
    {
      let accum = 0;
      for (let i = 0; i < gridCols.length; i += 1) {
        colXOffset.set(gridCols[i]!, accum);
        colWidthByStart.set(gridCols[i]!, colWidths[i]!);
        accum += colWidths[i]!;
      }
    }

    const avgColW = contentW / Math.max(1, gridCols.length);
    const size = Math.max(6, Math.min(9, avgColW / 6));
    const ROW_H = size * 2.1;
    const TITLE_BLOCK = 28;
    const rowAreaH = CH - 2 * MARGIN - TITLE_BLOCK;
    const rowsPerPage = Math.max(1, Math.floor(rowAreaH / ROW_H));
    const rowCount = rowSpans.length;

    const WHITE = rgb(1, 1, 1);
    const CELL_BORDER = rgb(0.72, 0.72, 0.72);
    const TEXT_COL = rgb(0, 0, 0);

    // Helper: ancho cubierto por un span que arranca en startCol y termina
    // en endCol (sumando los anchos de las cols de la grilla cuyo startCol
    // cae dentro del rango del span).
    const spanRenderWidth = (startCol: number, endCol: number) => {
      let w = colWidthByStart.get(startCol) ?? avgColW;
      for (let i = 0; i < gridCols.length; i += 1) {
        const g = gridCols[i]!;
        if (g > startCol && g <= endCol) w += colWidths[i]!;
      }
      return w;
    };

    let offset = 0;
    let part = 0;
    const pageParts = Math.max(1, Math.ceil(rowCount / rowsPerPage));
    while (offset < rowCount) {
      part += 1;
      const page = pdf.addPage([CW, CH]);
      const head =
        rowCount > rowsPerPage ? `${title}  (parte ${part} de ${pageParts})` : title;
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
      const headerRowIdx = rowSpans.findIndex((spans) => spans.some((s) => s.text.trim()));

      for (let ri = offset; ri < limit; ri += 1) {
        const localIdx = ri - offset;
        const rowBottom = startY - (localIdx + 1) * ROW_H;
        const textY = rowBottom + ROW_H * 0.3;
        const isHeaderRow = ri === headerRowIdx;

        // Bordes de grilla en TODAS las cols de la fila (para que sea
        // visible aunque la celda este vacia).
        for (let i = 0; i < gridCols.length; i += 1) {
          const xCell = MARGIN + (colXOffset.get(gridCols[i]!) ?? 0);
          page.drawRectangle({
            x: xCell,
            y: rowBottom,
            width: colWidths[i]!,
            height: ROW_H,
            color: WHITE,
            borderColor: CELL_BORDER,
            borderWidth: 0.35,
          });
        }

        for (const sp of rowSpans[ri]!) {
          if (!sp.text.trim()) continue;
          // Buscar la col de la grilla "ancla" mas cercana <= sp.startCol.
          let anchorCol = sp.startCol;
          if (!colXOffset.has(anchorCol)) {
            for (let i = gridCols.length - 1; i >= 0; i -= 1) {
              if (gridCols[i]! <= sp.startCol) {
                anchorCol = gridCols[i]!;
                break;
              }
            }
          }
          const xStart = MARGIN + (colXOffset.get(anchorCol) ?? 0);
          const w = spanRenderWidth(anchorCol, sp.endCol);
          const cap = Math.max(8, Math.floor(w / (size * 0.55)));
          const t = truncateCell(sp.text, cap);

          const isNum =
            !isHeaderRow && sp.text.trim() !== "" && /^-?\$?\s*-?[\d.,\s]+$/.test(sp.text.trim());
          let textX = xStart + 3;
          if (isNum) {
            try {
              const tw = font.widthOfTextAtSize(t, size);
              textX = xStart + w - 4 - tw;
            } catch {
              textX = xStart + w - 4 - t.length * size * 0.5;
            }
          }

          page.drawText(t, {
            x: Math.max(xStart + 2, Math.min(textX, xStart + w - 3)),
            y: textY,
            size,
            font: isHeaderRow ? fontBold : font,
            color: TEXT_COL,
            maxWidth: w - 5,
          });
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
