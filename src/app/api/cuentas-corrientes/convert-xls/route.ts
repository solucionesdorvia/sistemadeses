import { basename } from "node:path";

import * as XLSX from "xlsx";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return Response.json({ message: "Archivo .xls faltante." }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith(".xls")) {
      return Response.json({ message: "Solo se acepta .xls en este endpoint." }, { status: 400 });
    }

    const sourceName = basename(file.name);
    const targetName = sourceName.replace(/\.xls$/i, ".xlsx");

    const sourceBytes = new Uint8Array(await file.arrayBuffer());
    const workbook = XLSX.read(sourceBytes, {
      type: "array",
      cellDates: true,
    });

    if (!workbook.SheetNames?.length) {
      return Response.json(
        { message: "El archivo .xls no contiene hojas legibles." },
        { status: 400 },
      );
    }

    const outBuffer = XLSX.write(workbook, {
      bookType: "xlsx",
      type: "buffer",
    });

    return new Response(outBuffer, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Converted-Filename": targetName,
      },
    });
  } catch (error) {
    return Response.json(
      { message: error instanceof Error ? error.message : "No se pudo convertir .xls." },
      { status: 500 },
    );
  }
}
