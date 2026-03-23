import { inflateSync, inflateRawSync } from "node:zlib";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

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
        const vendorNumber = extractVendorFromPdf(pdfBytes);

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
      } catch (error) {
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

function extractVendorFromPdf(pdfBytes: Uint8Array): string | null {
  const rawText = Buffer.from(pdfBytes).toString("latin1");

  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let streamMatch: RegExpExecArray | null;
  let scanned = 0;

  while ((streamMatch = streamRegex.exec(rawText)) !== null && scanned < 30) {
    scanned++;
    const compressed = Buffer.from(streamMatch[1], "latin1");
    if (compressed.length < 10) continue;

    const inflated = tryInflate(compressed);
    if (!inflated) continue;

    const streamText = inflated.toString("latin1");
    const textFromOps = extractTextFromOperators(streamText);
    const found = matchVendor(textFromOps);
    if (found) return found;
  }

  const rawOps = extractTextFromOperators(rawText);
  const found = matchVendor(rawOps);
  if (found) return found;

  const printable = rawText.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").slice(0, 50000);
  return matchVendor(printable);
}

function tryInflate(compressed: Buffer): Buffer | null {
  try {
    return inflateSync(compressed);
  } catch { /* not zlib */ }
  try {
    return inflateRawSync(compressed);
  } catch { /* not raw deflate */ }
  return null;
}

function matchVendor(text: string): string | null {
  for (const pattern of VENDOR_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return stripLeadingZeros(match[1]);
  }
  return null;
}

function extractTextFromOperators(text: string): string {
  const lines: string[] = [];

  const tjArray = /\[(.*?)\]\s*TJ/gs;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = tjArray.exec(text)) !== null && count < 5000) {
    count++;
    const tokenRe = /\(([^()]*(?:\\.[^()]*)*)\)/g;
    let t: RegExpExecArray | null;
    let line = "";
    while ((t = tokenRe.exec(m[1])) !== null) {
      line += unescapePdf(t[1]);
    }
    if (line.trim()) lines.push(line);
  }

  const tjSingle = /\(([^()]*(?:\\.[^()]*)*)\)\s*Tj/g;
  count = 0;
  while ((m = tjSingle.exec(text)) !== null && count < 5000) {
    count++;
    const decoded = unescapePdf(m[1]);
    if (decoded.trim()) lines.push(decoded);
  }

  return lines.join(" ");
}

function unescapePdf(value: string): string {
  return value
    .replace(/\\([nrtbf()\\])/g, "$1")
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => {
      const code = Number.parseInt(oct, 8);
      return Number.isNaN(code) ? "" : String.fromCharCode(code);
    });
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
