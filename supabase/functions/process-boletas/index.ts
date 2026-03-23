import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";
import { getRequestUserId } from "../_shared/auth.ts";

type RequestBody = { filePaths: string[] };

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const VENDOR_PATTERNS = [
  /cliente\s*[:#-]?\s*\d{1,12}\s+vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})\s+vto/i,
  /vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})/i,
];

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestUserId = await getRequestUserId(request);
    const body = (await request.json()) as RequestBody;
    const diagnostics: string[] = [];

    for (const filePath of body.filePaths ?? []) {
      const fileResult = await supabase
        .from("files")
        .select("id,user_id,original_filename")
        .eq("file_path", filePath)
        .eq("user_id", requestUserId)
        .single();

      if (fileResult.error || !fileResult.data) continue;

      try {
        const uploadResult = await supabase.storage.from("uploads").download(filePath);
        if (uploadResult.error || !uploadResult.data) {
          throw new Error("No se pudo descargar el PDF de boleta desde Storage.");
        }

        const fileBuffer = new Uint8Array(await uploadResult.data.arrayBuffer());
        diagnostics.push(`file=${filePath} size=${fileBuffer.length}`);

        const { vendorNumber, diag } = await extractVendorFromPdf(fileBuffer);
        diagnostics.push(...diag);
        diagnostics.push(`result=${vendorNumber ?? "null"}`);

        let vendorId: string | null = null;
        if (vendorNumber) {
          const vendorResult = await supabase
            .from("vendors")
            .select("id")
            .eq("user_id", requestUserId)
            .eq("vendor_number", vendorNumber)
            .maybeSingle();

          vendorId = vendorResult.data?.id ?? null;

          if (!vendorId) {
            const candidatesResult = await supabase
              .from("vendors")
              .select("id,vendor_number")
              .eq("user_id", requestUserId)
              .not("vendor_number", "is", null);

            if (!candidatesResult.error && candidatesResult.data) {
              const matched = candidatesResult.data.find((c) =>
                normalizeVendorNumber(c.vendor_number) === vendorNumber,
              );
              vendorId = matched?.id ?? null;
            }
          }
        }

        await supabase.from("boleta_analyses").insert({
          user_id: fileResult.data.user_id,
          file_id: fileResult.data.id,
          vendor_id: vendorId,
          vendor_number: vendorNumber,
          analysis_text: vendorNumber
            ? `Numero de vendedor detectado desde PDF: ${vendorNumber}`
            : null,
          extracted_data: { vendorNumber, source: vendorNumber ? "pdf-regex" : "not-found", diagnostics },
          confidence_score: 0.85,
        });

        await supabase.from("files").update({ status: "completed" }).eq("id", fileResult.data.id);
      } catch (error) {
        diagnostics.push(`error=${error instanceof Error ? error.message : "unknown"}`);
        await supabase
          .from("files")
          .update({
            status: "error",
            error_message: error instanceof Error ? error.message : "No se pudo analizar el PDF.",
          })
          .eq("id", fileResult.data.id);
      }
    }

    return json({ ok: true, diagnostics });
  } catch (error) {
    return json(
      { message: error instanceof Error ? error.message : "Error inesperado." },
      500,
    );
  }
});

async function tryInflateBlob(compressed: Uint8Array): Promise<Uint8Array | null> {
  try {
    const blob = new Blob([compressed]);
    const ds = new DecompressionStream("deflate");
    const stream = blob.stream().pipeThrough(ds);
    const arrayBuffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } catch {
    return null;
  }
}

async function extractVendorFromPdf(
  pdfBytes: Uint8Array,
): Promise<{ vendorNumber: string | null; diag: string[] }> {
  const diag: string[] = [];
  const rawText = new TextDecoder("latin1").decode(pdfBytes);

  // 1) Try each decompressed Flate stream
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let streamMatch: RegExpExecArray | null;
  let scanned = 0;
  let inflatedCount = 0;

  while ((streamMatch = streamRegex.exec(rawText)) !== null && scanned < 30) {
    scanned++;
    const compressed = latin1ToBytes(streamMatch[1]);
    if (compressed.length < 10) continue;

    const inflated = await tryInflateBlob(compressed);
    if (!inflated) continue;
    inflatedCount++;

    const streamText = new TextDecoder("latin1").decode(inflated);
    const textFromOps = extractTextFromOperators(streamText);

    if (textFromOps.length > 0) {
      diag.push(`stream${scanned}: ${textFromOps.length}chars "${textFromOps.slice(0, 100)}"`);
    }

    const found = matchVendor(textFromOps);
    if (found) {
      diag.push(`matched_in_stream=${scanned}`);
      return { vendorNumber: found, diag };
    }

    // Also check raw decompressed text directly
    const foundRaw = matchVendor(streamText);
    if (foundRaw) {
      diag.push(`matched_raw_stream=${scanned}`);
      return { vendorNumber: foundRaw, diag };
    }
  }

  diag.push(`streams_scanned=${scanned} inflated=${inflatedCount}`);

  // 2) Fallback: TJ operators from raw PDF
  const rawOps = extractTextFromOperators(rawText);
  diag.push(`raw_ops=${rawOps.length}chars`);
  const found = matchVendor(rawOps);
  if (found) {
    diag.push("matched_in_raw_ops");
    return { vendorNumber: found, diag };
  }

  // 3) Last resort: printable ASCII
  const printable = rawText.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").slice(0, 50000);
  const foundPrint = matchVendor(printable);
  if (foundPrint) {
    diag.push("matched_in_printable");
    return { vendorNumber: foundPrint, diag };
  }

  diag.push("no_match");
  return { vendorNumber: null, diag };
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
    const inside = m[1];
    const tokenRe = /\(([^()]*(?:\\.[^()]*)*)\)/g;
    let t: RegExpExecArray | null;
    let line = "";
    while ((t = tokenRe.exec(inside)) !== null) {
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

  const explicitMatch = trimmed.match(/(?:vend(?:edor)?\.?\s*:?\s*)(\d{1,8})/i);
  if (explicitMatch?.[1]) return stripLeadingZeros(explicitMatch[1]);

  const numberTokens = trimmed.match(/\d+/g) ?? [];
  if (numberTokens.length === 1) return stripLeadingZeros(numberTokens[0]);

  const digitsOnly = trimmed.replace(/[^\d]/g, "");
  if (digitsOnly.length > 0) return stripLeadingZeros(digitsOnly);

  return null;
}

function stripLeadingZeros(raw: string): string {
  return raw.replace(/^0+/, "").trim() || "0";
}

function latin1ToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
