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

/** A4 vertical (pt) — igual que el PDF de LibreOffice (portrait +
 *  fitToWidth). Vertical para que las capturas desde el celular entren
 *  completas a lo ancho. El auto-fit de tamaño de letra (12 -> 7 pt)
 *  achica el texto hasta que el renglon completo entre sin truncar.
 *  Si el contenido excede una pagina, se agregan mas. */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 30;

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
  const fontBoldItalic = await pdf.embedFont(StandardFonts.HelveticaBoldOblique);
  const label = basename(fileName);

  // Patron de los textos "cabecera" del Excel original — el LibreOffice
  // nativo los muestra en negrita-cursiva. Reproducimos el estilo en el
  // fallback para que el PDF se parezca al de cuando LO funciona.
  const isHeaderText = (s: string) =>
    /^\s*(?:vendedor|cliente|total)\b/i.test(s);

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

    const gridCols = [...startColSet].sort((a, b) => a - b);

    // Filtrar a solo las filas que tienen contenido. El Excel original
    // tiene muchas rows separadoras de altura minima (0.75pt) que en LO
    // casi no se ven, pero el fallback les da altura completa y termina
    // ocupando 3 paginas. Sacarlas reproduce mejor la version original.
    const renderRows = rowSpans.filter((spans) => spans.some((s) => s.text.trim()));

    // Si no hay merges relevantes ni datos en cols separadas, no podemos
    // armar una grilla útil — saltar al render plano por celdas.
    if (gridCols.length < 2) {
      const p = pdf.addPage([PAGE_W, PAGE_H]);
      let yCursor = PAGE_H - MARGIN - 14;
      for (const spans of renderRows) {
        if (yCursor < MARGIN + 12) break;
        const line = spans.map((s) => s.text).join("  ");
        p.drawText(truncateCell(line, 200), { x: MARGIN, y: yCursor, size: 8, font });
        yCursor -= 12;
      }
      continue;
    }

    const CW = PAGE_W;
    const CH = PAGE_H;
    const contentW = CW - 2 * MARGIN;

    // Ancho por columna: para cada col, calcular el ancho real necesario
    // segun el texto mas largo que aparece ahi. Si la suma entra en la
    // pagina, usar ese ancho. Si no, ir reduciendo el size hasta que
    // entre. Asi los importes "$ 2,743,923.00" entran completos y
    // "001 CUENTA CORRIENTE" no se trunca a "CORRIE...".
    // Ancho REAL del texto medido con la fuente (por punto de tamano), no
    // estimado por cantidad de caracteres: "001 CUENTA CORRIENTE" en
    // mayusculas es mas ancho que 20 chars promedio y con la estimacion
    // se comia el padding (el "$" de la col siguiente quedaba pegado).
    const measureUnitWidth = (text: string) => {
      try {
        return fontBold.widthOfTextAtSize(text, 1);
      } catch {
        return text.length * 0.55;
      }
    };
    const colMaxUnitW = new Map<number, number>();
    for (const spans of renderRows) {
      for (const sp of spans) {
        const prev = colMaxUnitW.get(sp.startCol) ?? 0;
        colMaxUnitW.set(sp.startCol, Math.max(prev, measureUnitWidth(sp.text)));
      }
    }
    const unitWidths = gridCols.map((g) => Math.max(colMaxUnitW.get(g) ?? 0, 1.5));
    // Padding por celda proporcional al tamano de letra: separa un span
    // del siguiente (sino "CORRIENTE" queda pegado al "$" del importe).
    const padFor = (s: number) => Math.max(5, s * 0.9);
    const computeFit = (s: number) => {
      const pad = padFor(s);
      const widths = unitWidths.map((u) => u * s + pad);
      const sum = widths.reduce((a, b) => a + b, 0);
      return { widths, sum };
    };
    // Buscar el size mas grande que entra (entre 5 y 12). En A4 vertical
    // los renglones largos de cuenta corriente necesitan bajar hasta
    // ~6pt: preferimos letra chica antes que truncar importes con "…".
    let size = 5;
    for (let s = 12; s >= 5; s -= 0.5) {
      if (computeFit(s).sum <= contentW) {
        size = s;
        break;
      }
    }
    let colWidths: number[];
    const fit = computeFit(size);
    if (fit.sum <= contentW) {
      // Entra holgado: escalar al ancho disponible para que use toda la pagina.
      const factor = contentW / fit.sum;
      colWidths = fit.widths.map((w) => w * factor);
    } else {
      // Ni con 5pt entra: escalar proporcionalmente (ultimo recurso).
      colWidths = fit.widths.map((w) => (w / fit.sum) * contentW);
    }

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
    const ROW_H = size * 1.9;
    const GAP_BEFORE_HEADER = size * 0.8;
    const rowCount = renderRows.length;

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

    let ri = 0;
    while (ri < rowCount) {
      const page = pdf.addPage([CW, CH]);
      let yCursor = CH - MARGIN;
      const yMin = MARGIN + ROW_H;

      while (ri < rowCount) {
        const rowHasHeader = renderRows[ri]!.some((s) => isHeaderText(s.text));
        // Gap antes de Vendedor/Cliente/Total (excepto la 1ra fila de la pagina).
        const needsGap = rowHasHeader && yCursor < CH - MARGIN;
        const rowAdvance = ROW_H + (needsGap ? GAP_BEFORE_HEADER : 0);
        if (yCursor - rowAdvance < yMin) break;
        if (needsGap) yCursor -= GAP_BEFORE_HEADER;

        const rowBottom = yCursor - ROW_H;
        const textY = rowBottom + ROW_H * 0.3;

        for (const sp of renderRows[ri]!) {
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

          const isHeader = isHeaderText(sp.text);
          const isNum =
            !isHeader && sp.text.trim() !== "" && /^-?\$?\s*-?[\d.,\s]+$/.test(sp.text.trim());
          const chosenFont = isHeader ? fontBoldItalic : font;
          let textX = xStart + 3;
          if (isNum) {
            try {
              const tw = chosenFont.widthOfTextAtSize(t, size);
              textX = xStart + w - 4 - tw;
            } catch {
              textX = xStart + w - 4 - t.length * size * 0.5;
            }
          }

          page.drawText(t, {
            x: Math.max(xStart + 2, Math.min(textX, xStart + w - 3)),
            y: textY,
            size,
            font: chosenFont,
            color: TEXT_COL,
          });
        }

        yCursor -= ROW_H;
        ri += 1;
      }
    }
  }

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
