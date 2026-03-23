import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";
import { getRequestUserId } from "../_shared/auth.ts";

type RequestBody = { filePaths: string[] };

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestUserId = await getRequestUserId(request);
    const body = (await request.json()) as RequestBody;
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
        console.log(`[process-boletas] Processing ${filePath} (${fileBuffer.length} bytes)`);

        const extracted = await analyzeWithAi(
          filePath,
          fileBuffer,
          fileResult.data.original_filename ?? null,
        );
        console.log(`[process-boletas] Extraction:`, JSON.stringify(extracted).slice(0, 500));

        const vendorNumber = normalizeVendorNumber(extracted.vendorNumber ?? null);
        console.log(`[process-boletas] Vendor number: ${vendorNumber}`);

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
              const matched = candidatesResult.data.find((candidate) => {
                return normalizeVendorNumber(candidate.vendor_number) === vendorNumber;
              });
              vendorId = matched?.id ?? null;
            }
          }
        }

        await supabase.from("boleta_analyses").insert({
          user_id: fileResult.data.user_id,
          file_id: fileResult.data.id,
          vendor_id: vendorId,
          vendor_number: vendorNumber,
          analysis_text: extracted.analysisText,
          extracted_data: extracted,
          confidence_score: 0.85,
        });

        await supabase.from("files").update({ status: "completed" }).eq("id", fileResult.data.id);
      } catch (error) {
        console.error(`[process-boletas] Error processing ${filePath}:`, error);
        await supabase
          .from("files")
          .update({
            status: "error",
            error_message:
              error instanceof Error ? error.message : "No se pudo analizar el PDF.",
          })
          .eq("id", fileResult.data.id);
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ message: error instanceof Error ? error.message : "Error inesperado." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

async function analyzeWithAi(
  filePath: string,
  pdfBytes: Uint8Array,
  originalFilename: string | null,
) {
  const vendorNumberFromPdf = await extractVendorNumberFromPdf(pdfBytes);
  if (vendorNumberFromPdf) {
    return {
      vendorNumber: vendorNumberFromPdf,
      date: null,
      amount: null,
      concept: null,
      analysisText: `Numero de vendedor detectado desde PDF: ${vendorNumberFromPdf}`,
      source: "pdf-regex",
      filePath,
      originalFilename,
    };
  }

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY no configurado.");
  }

  const extractedTextHint = await decodePdfTextHint(pdfBytes);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Extrae datos de boletas y devuelve SOLO JSON valido con vendorNumber, date, amount, concept y analysisText.",
        },
        {
          role: "user",
          content:
            `Analiza esta boleta. Si no puedes inferir un campo, devuelve null.\n` +
            `Path de referencia: ${filePath}\n` +
            `Nombre original: ${originalFilename ?? "desconocido"}\n` +
            `Texto extraido del PDF (puede estar incompleto):\n` +
            `${extractedTextHint}`,
        },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI error (${response.status}).`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(content);
}

function normalizeVendorNumber(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const explicitMatch = trimmed.match(/(?:vend(?:edor)?\.?\s*:?\s*)(\d{1,8})/i);
  if (explicitMatch?.[1]) {
    return stripLeadingZeros(explicitMatch[1]);
  }

  const numberTokens = trimmed.match(/\d+/g) ?? [];
  if (numberTokens.length === 1) {
    return stripLeadingZeros(numberTokens[0]);
  }

  const digitsOnly = trimmed.replace(/[^\d]/g, "");
  if (digitsOnly.length > 0 && /^\D*\d[\d\D]*$/.test(trimmed)) {
    return stripLeadingZeros(digitsOnly);
  }

  return null;
}

function stripLeadingZeros(raw: string) {
  return raw.replace(/^0+/, "").trim() || "0";
}

async function extractVendorNumberFromPdf(pdfBytes: Uint8Array) {
  const text = await decodePdfTextHint(pdfBytes);

  console.log(`[process-boletas] Extracted text length: ${text.length}`);
  const vendIdx = text.toLowerCase().indexOf("vend");
  if (vendIdx >= 0) {
    console.log(`[process-boletas] Found 'vend' at ${vendIdx}: "${text.slice(Math.max(0, vendIdx - 30), vendIdx + 50)}"`);
  } else {
    console.log(`[process-boletas] 'vend' NOT found in extracted text`);
  }

  const patterns = [
    /cliente\s*[:#-]?\s*\d{1,12}\s+vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})\s+vto/i,
    /vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})/i,
    /n(?:ro|ro\.|umero|úmero)?\s*vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})/i,
    /vend(?:edor)?[^0-9]{0,20}0*([0-9]{1,8})[^0-9]{0,20}vto/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      console.log(`[process-boletas] Matched pattern ${pattern}, vendor: ${match[1]}`);
      return stripLeadingZeros(match[1]);
    }
  }

  const compactText = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const compactPatterns = [
    /cliente\d{1,12}vend(?:edor)?0*([0-9]{1,8})vto/i,
    /vend(?:edor)?0*([0-9]{1,8})/i,
    /n(?:ro|numero)?vend(?:edor)?0*([0-9]{1,8})/i,
    /vend0*([0-9]{1,8})vto/i,
  ];

  for (const pattern of compactPatterns) {
    const match = compactText.match(pattern);
    if (match?.[1]) {
      return stripLeadingZeros(match[1]);
    }
  }

  return null;
}

async function tryDecompress(
  compressed: Uint8Array,
  format: string,
): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream(format as "deflate");
    const writer = ds.writable.getWriter();
    const writePromise = writer.write(compressed);
    const closePromise = writer.close();
    await Promise.all([writePromise, closePromise]);

    const reader = ds.readable.getReader();
    const parts: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  } catch {
    return null;
  }
}

async function inflateAny(compressed: Uint8Array): Promise<Uint8Array | null> {
  return (
    (await tryDecompress(compressed, "deflate")) ??
    (await tryDecompress(compressed, "deflate-raw")) ??
    (await tryDecompress(compressed.slice(2), "deflate-raw"))
  );
}

async function decodePdfTextHint(pdfBytes: Uint8Array) {
  const rawText = new TextDecoder("latin1").decode(pdfBytes);
  const decompressedText = await extractFlateStreamsText(rawText);
  const combined = `${rawText}\n${decompressedText}`;
  const operatorText = extractPdfTextOperators(combined);
  const literalStrings = extractPdfLiteralStrings(combined);
  const hexStrings = extractPdfHexStrings(combined);
  const printableRaw = extractPrintableAscii(rawText);

  console.log(`[process-boletas] Text sizes - operators: ${operatorText.length}, literals: ${literalStrings.length}, hex: ${hexStrings.length}, decompressed: ${decompressedText.length}, printable: ${printableRaw.length}`);

  return `${operatorText}\n${literalStrings}\n${hexStrings}\n${decompressedText}\n${printableRaw}`
    .replace(/\s+/g, " ")
    .slice(0, 400000);
}

async function extractFlateStreamsText(pdfLatin1: string) {
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  const chunks: string[] = [];
  let scanned = 0;
  let inflatedCount = 0;

  while ((match = streamRegex.exec(pdfLatin1)) !== null && scanned < 120) {
    scanned += 1;
    const streamData = match[1];
    if (!streamData) continue;

    const compressed = latin1ToUint8Array(streamData);

    const inflated = await inflateAny(compressed);

    if (inflated) {
      inflatedCount += 1;
      chunks.push(new TextDecoder("latin1").decode(inflated));
    }
  }

  console.log(`[process-boletas] Flate streams: scanned=${scanned}, inflated=${inflatedCount}`);
  return chunks.join("\n");
}

function extractPdfLiteralStrings(text: string) {
  const parts: string[] = [];
  const pattern = /\(([^()]*(?:\\.[^()]*)*)\)/g;
  let match: RegExpExecArray | null;
  let scanned = 0;

  while ((match = pattern.exec(text)) !== null && scanned < 25000) {
    scanned += 1;
    parts.push(decodePdfEscapedString(match[1]));
  }

  return parts.join(" ");
}

function extractPdfHexStrings(text: string) {
  const parts: string[] = [];
  const pattern = /<([0-9A-Fa-f\s]{4,})>/g;
  let match: RegExpExecArray | null;
  let scanned = 0;

  while ((match = pattern.exec(text)) !== null && scanned < 25000) {
    scanned += 1;
    const decoded = decodePdfHexString(match[1]);
    if (decoded) {
      parts.push(decoded);
    }
  }

  return parts.join(" ");
}

function decodePdfHexString(value: string) {
  const sanitized = value.replace(/\s+/g, "");
  if (!/^[0-9A-Fa-f]+$/.test(sanitized)) return "";
  if (sanitized.length < 4) return "";

  const evenHex = sanitized.length % 2 === 0 ? sanitized : `${sanitized}0`;
  const bytes = new Uint8Array(evenHex.length / 2);
  for (let index = 0; index < evenHex.length; index += 2) {
    const byteValue = Number.parseInt(evenHex.slice(index, index + 2), 16);
    if (Number.isNaN(byteValue)) return "";
    bytes[index / 2] = byteValue;
  }

  let zeroHighBytes = 0;
  const pairs = Math.floor(bytes.length / 2);
  for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
    if (bytes[pairIndex * 2] === 0x00) zeroHighBytes += 1;
  }

  const looksUtf16Be = pairs > 0 && zeroHighBytes / pairs > 0.35;
  try {
    return looksUtf16Be
      ? new TextDecoder("utf-16be").decode(bytes)
      : new TextDecoder("latin1").decode(bytes);
  } catch {
    return "";
  }
}

function decodePdfEscapedString(value: string) {
  return value
    .replace(/\\([nrtbf()\\])/g, "$1")
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) => {
      const code = Number.parseInt(octal, 8);
      return Number.isNaN(code) ? "" : String.fromCharCode(code);
    });
}

function extractPdfTextOperators(text: string) {
  const chunks: string[] = [];

  const tjArrayPattern = /\[(.*?)\]\s*TJ/gs;
  let arrayMatch: RegExpExecArray | null;
  let arraysScanned = 0;
  while ((arrayMatch = tjArrayPattern.exec(text)) !== null && arraysScanned < 30000) {
    arraysScanned += 1;
    const inside = arrayMatch[1];
    const tokenPattern = /\(([^()]*(?:\\.[^()]*)*)\)|<([0-9A-Fa-f\s]{2,})>/g;
    let tokenMatch: RegExpExecArray | null;
    let line = "";

    while ((tokenMatch = tokenPattern.exec(inside)) !== null) {
      if (tokenMatch[1] !== undefined) {
        line += decodePdfEscapedString(tokenMatch[1]);
      } else if (tokenMatch[2] !== undefined) {
        line += decodePdfHexString(tokenMatch[2]);
      }
    }

    if (line.trim()) {
      chunks.push(line);
    }
  }

  const tjPattern = /\(([^()]*(?:\\.[^()]*)*)\)\s*Tj/g;
  let match: RegExpExecArray | null;
  let scanned = 0;
  while ((match = tjPattern.exec(text)) !== null && scanned < 30000) {
    scanned += 1;
    const decoded = decodePdfEscapedString(match[1]);
    if (decoded.trim()) {
      chunks.push(decoded);
    }
  }

  return chunks.join("\n");
}

function extractPrintableAscii(text: string) {
  return text
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 200000);
}

function latin1ToUint8Array(value: string) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}
