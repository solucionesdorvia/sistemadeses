import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
// PDFs grandes con pdfjs pueden tomar tiempo. Sin maxDuration, Next.js
// corta a 30s default y el handler se interrumpe a la mitad.
export const maxDuration = 300;

type Body = { filePaths: string[] };

const VENDOR_PATTERNS = [
  /cliente\s*[:#-]?\s*\d{1,12}\s+vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})\s+vto/i,
  /vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})/i,
];

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    if (!body?.filePaths?.length) {
      return Response.json({ message: "No se recibieron archivos." }, { status: 400 });
    }

    const supabase = await createClient();
    const admin = createAdminClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return Response.json({ message: "Sesion invalida." }, { status: 401 });

    for (const filePath of body.filePaths) {
      const fileStart = Date.now();
      const fileResult = await admin
        .from("files")
        .select("id,user_id,original_filename")
        .eq("file_path", filePath)
        .eq("user_id", user.id)
        .single();

      if (fileResult.error || !fileResult.data) continue;

      try {
        const downloaded = await admin.storage.from("uploads").download(filePath);
        if (downloaded.error || !downloaded.data) {
          throw new Error("No se pudo descargar el PDF.");
        }

        const pdfBytes = new Uint8Array(await downloaded.data.arrayBuffer());
        const extractStart = Date.now();
        const vendorNumber = await extractVendorFromPdf(pdfBytes);
        console.log(
          `[boletas] file=${fileResult.data.original_filename} pdfBytes=${pdfBytes.length} extractMs=${Date.now() - extractStart} vendor=${vendorNumber}`,
        );

        let vendorId: string | null = null;
        if (vendorNumber) {
          const direct = await admin
            .from("vendors")
            .select("id")
            .eq("user_id", user.id)
            .eq("vendor_number", vendorNumber)
            .maybeSingle();

          vendorId = direct.data?.id ?? null;

          if (!vendorId) {
            const candidates = await admin
              .from("vendors")
              .select("id,vendor_number")
              .eq("user_id", user.id)
              .not("vendor_number", "is", null);

            if (!candidates.error && candidates.data) {
              const matched = candidates.data.find(
                (c) => normalizeVendorNumber(c.vendor_number) === vendorNumber,
              );
              vendorId = matched?.id ?? null;
            }
          }
        }

        await admin.from("boleta_analyses").insert({
          user_id: user.id,
          file_id: fileResult.data.id,
          vendor_id: vendorId,
          vendor_number: vendorNumber,
          analysis_text: vendorNumber
            ? `Numero de vendedor detectado desde PDF: ${vendorNumber}`
            : null,
          extracted_data: { vendorNumber, source: vendorNumber ? "pdf-regex" : "not-found" },
          confidence_score: 0.85,
        });

        await admin.from("files").update({ status: "completed" }).eq("id", fileResult.data.id);
        console.log(`[boletas] file=${fileResult.data.original_filename} totalMs=${Date.now() - fileStart}`);
      } catch (error) {
        console.error(
          `[boletas] file=${fileResult.data.original_filename} FALLO totalMs=${Date.now() - fileStart}:`,
          error,
        );
        await admin
          .from("files")
          .update({
            status: "error",
            error_message: error instanceof Error ? error.message : "No se pudo analizar el PDF.",
          })
          .eq("id", fileResult.data.id);
      }
    }

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { message: error instanceof Error ? error.message : "Error inesperado." },
      { status: 500 },
    );
  }
}

async function extractVendorFromPdf(pdfBytes: Uint8Array): Promise<string | null> {
  // pdfjs-dist decodifica fuentes embebidas con encoding custom (lo que
  // el regex no podia hacer). PDFs como las boletas de Desesplast tienen
  // TrueType subseteadas: cada glifo es un codigo binario, no ASCII.
  // pdfjs lee la tabla ToUnicode/CMap y devuelve el string real.
  let allText = "";
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — paquete sin tipos en algunos casos
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: pdfBytes,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
    // Solo escaneamos las primeras 3 paginas: el vendedor siempre aparece
    // al inicio en la cabecera de la boleta.
    const maxPages = Math.min(doc.numPages, 3);
    for (let p = 1; p <= maxPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pageText = content.items.map((it: any) => it.str ?? "").join(" ");
      allText += `${pageText}\n`;
      const partial = matchVendor(allText);
      if (partial) return partial;
    }
  } catch (e) {
    console.error("[boletas] pdfjs fallo, no se pudo extraer texto:", e);
    return null;
  }
  return matchVendor(allText);
}

function matchVendor(text: string): string | null {
  for (const pattern of VENDOR_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return stripLeadingZeros(match[1]);
  }
  return null;
}

function normalizeVendorNumber(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const explicit = trimmed.match(/(?:vend(?:edor)?\.?\s*:?\s*)(\d{1,8})/i);
  if (explicit?.[1]) return stripLeadingZeros(explicit[1]);

  const tokens = trimmed.match(/\d+/g) ?? [];
  if (tokens.length === 1) return stripLeadingZeros(tokens[0]);

  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length > 0) return stripLeadingZeros(digits);

  return null;
}

function stripLeadingZeros(raw: string): string {
  return raw.replace(/^0+/, "").trim() || "0";
}
