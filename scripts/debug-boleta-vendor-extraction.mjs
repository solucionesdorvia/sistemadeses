import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import zlib from "node:zlib";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const fileId = process.argv[2];
if (!fileId) {
  console.error("Usage: node scripts/debug-boleta-vendor-extraction.mjs <file_id>");
  process.exit(1);
}

const fileResult = await supabase
  .from("files")
  .select("id,original_filename,file_path")
  .eq("id", fileId)
  .single();

if (fileResult.error || !fileResult.data) {
  throw new Error(fileResult.error?.message ?? "File not found");
}

const download = await supabase.storage.from("uploads").download(fileResult.data.file_path);
if (download.error || !download.data) {
  throw new Error(download.error?.message ?? "Download failed");
}

const bytes = new Uint8Array(await download.data.arrayBuffer());
const rawText = new TextDecoder("latin1").decode(bytes);
const decompressedText = extractFlateStreamsText(rawText);
const combined = `${rawText}\n${decompressedText}`;
const literalStrings = extractPdfLiteralStrings(combined);
const hexStrings = extractPdfHexStrings(combined);
const full = `${combined}\n${literalStrings}\n${hexStrings}`.replace(/\s+/g, " ");
const compact = full.toLowerCase().replace(/[^a-z0-9]/g, "");

const patterns = [
  /vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})/i,
  /n(?:ro|ro\.|umero|úmero)?\s*vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})/i,
  /vend[^0-9]{0,30}0*([0-9]{1,8})[^0-9]{0,30}vto/i,
];
const compactPatterns = [
  /vend(?:edor)?0*([0-9]{1,8})/i,
  /n(?:ro|numero)?vend(?:edor)?0*([0-9]{1,8})/i,
  /vend0*([0-9]{1,8})vto/i,
];

const found = [];
for (const pattern of patterns) {
  const match = full.match(pattern);
  if (match?.[1]) found.push({ source: "full", pattern: pattern.source, value: match[1] });
}
for (const pattern of compactPatterns) {
  const match = compact.match(pattern);
  if (match?.[1]) found.push({ source: "compact", pattern: pattern.source, value: match[1] });
}

const vendIndex = compact.indexOf("vend");
console.log(
  JSON.stringify(
    {
      file: fileResult.data,
      sizes: {
        raw: rawText.length,
        decompressed: decompressedText.length,
        literal: literalStrings.length,
        hex: hexStrings.length,
        full: full.length,
        compact: compact.length,
      },
      found,
      compactPreview:
        vendIndex >= 0
          ? compact.slice(Math.max(0, vendIndex - 80), Math.min(compact.length, vendIndex + 220))
          : null,
    },
    null,
    2,
  ),
);

function extractFlateStreamsText(pdfLatin1) {
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match = null;
  const chunks = [];
  let scanned = 0;
  while ((match = streamRegex.exec(pdfLatin1)) !== null && scanned < 120) {
    scanned += 1;
    const streamData = match[1];
    if (!streamData) continue;
    const compressed = latin1ToUint8Array(streamData);
    const candidates = [compressed, compressed.slice(2)];
    for (const candidate of candidates) {
      if (!candidate.length) continue;
      try {
        chunks.push(new TextDecoder("latin1").decode(zlib.inflateSync(candidate)));
        break;
      } catch {
        // Ignore non-deflated streams.
      }
    }
  }
  return chunks.join("\n");
}

function extractPdfLiteralStrings(text) {
  const parts = [];
  const pattern = /\(([^()]*(?:\\.[^()]*)*)\)/g;
  let match = null;
  let scanned = 0;
  while ((match = pattern.exec(text)) !== null && scanned < 25000) {
    scanned += 1;
    parts.push(
      match[1]
        .replace(/\\([nrtbf()\\])/g, "$1")
        .replace(/\\([0-7]{1,3})/g, (_, octal) =>
          String.fromCharCode(Number.parseInt(octal, 8)),
        ),
    );
  }
  return parts.join(" ");
}

function extractPdfHexStrings(text) {
  const parts = [];
  const pattern = /<([0-9A-Fa-f\s]{4,})>/g;
  let match = null;
  let scanned = 0;
  while ((match = pattern.exec(text)) !== null && scanned < 25000) {
    scanned += 1;
    const decoded = decodePdfHexString(match[1]);
    if (decoded) parts.push(decoded);
  }
  return parts.join(" ");
}

function decodePdfHexString(value) {
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

function latin1ToUint8Array(value) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}
