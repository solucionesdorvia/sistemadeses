import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import zlib from "node:zlib";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const normalizeVendorNumber = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const explicit = trimmed.match(/(?:vend(?:edor)?\.?\s*:?\s*)(\d{1,8})/i);
  if (explicit?.[1]) {
    return explicit[1].replace(/^0+/, "").trim() || "0";
  }

  const tokens = trimmed.match(/\d+/g) ?? [];
  if (tokens.length === 1) {
    return tokens[0].replace(/^0+/, "").trim() || "0";
  }

  const digits = trimmed.replace(/[^\d]/g, "");
  return digits ? digits.replace(/^0+/, "").trim() || "0" : null;
};

const decodePdfEscapedString = (value) =>
  value
    .replace(/\\([nrtbf()\\])/g, "$1")
    .replace(/\\([0-7]{1,3})/g, (_, octal) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );

const extractPdfText = (pdfBuffer) => {
  const rawLatin1 = pdfBuffer.toString("latin1");
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;

  let match;
  let scannedStreams = 0;
  let inflated = "";
  while ((match = streamRegex.exec(rawLatin1)) !== null && scannedStreams < 120) {
    scannedStreams += 1;
    const compressed = Buffer.from(match[1], "latin1");
    for (const candidate of [compressed, compressed.subarray(2)]) {
      if (!candidate.length) continue;
      try {
        inflated += zlib.inflateSync(candidate).toString("latin1");
        inflated += "\n";
        break;
      } catch {
        // no-op
      }
    }
  }

  const merged = `${rawLatin1}\n${inflated}`;
  const literalRegex = /\(([^()]*(?:\\.[^()]*)*)\)/g;
  const literalParts = [];
  let literal;
  let scannedLiterals = 0;
  while ((literal = literalRegex.exec(merged)) !== null && scannedLiterals < 25000) {
    scannedLiterals += 1;
    literalParts.push(decodePdfEscapedString(literal[1]));
  }

  return `${merged}\n${literalParts.join(" ")}`.replace(/\s+/g, " ").slice(0, 50000);
};

const extractVendorNumberFromPdf = (text) => {
  const patterns = [
    /vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})/i,
    /n(?:ro|ro\.|umero|úmero)?\s*vend(?:edor)?\s*[:#-]?\s*0*([0-9]{1,8})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/^0+/, "").trim() || "0";
    }
  }

  const compact = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const compactPatterns = [
    /vend(?:edor)?0*([0-9]{1,8})/i,
    /n(?:ro|numero)?vend(?:edor)?0*([0-9]{1,8})/i,
  ];
  for (const pattern of compactPatterns) {
    const match = compact.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/^0+/, "").trim() || "0";
    }
  }
  return null;
};

const analysesResult = await supabase
  .from("boleta_analyses")
  .select("id,user_id,file_id,vendor_id,vendor_number")
  .is("vendor_id", null)
  .order("created_at", { ascending: false })
  .limit(500);

if (analysesResult.error) throw analysesResult.error;
const analyses = analysesResult.data ?? [];

if (analyses.length === 0) {
  console.log(JSON.stringify({ pending: 0, updated: 0, parsedFromPdf: 0, noMatch: 0 }));
  process.exit(0);
}

const userIds = [...new Set(analyses.map((row) => row.user_id).filter(Boolean))];
const fileIds = [...new Set(analyses.map((row) => row.file_id).filter(Boolean))];

const [vendorsResult, filesResult] = await Promise.all([
  supabase
    .from("vendors")
    .select("id,user_id,vendor_number")
    .in("user_id", userIds)
    .not("vendor_number", "is", null),
  supabase.from("files").select("id,file_path").in("id", fileIds),
]);

if (vendorsResult.error) throw vendorsResult.error;
if (filesResult.error) throw filesResult.error;

const filePathById = new Map((filesResult.data ?? []).map((row) => [row.id, row.file_path]));

const vendorIdByUserAndNumber = new Map();
for (const vendor of vendorsResult.data ?? []) {
  const normalized = normalizeVendorNumber(vendor.vendor_number);
  if (!normalized) continue;
  const key = `${vendor.user_id}:${normalized}`;
  if (!vendorIdByUserAndNumber.has(key)) {
    vendorIdByUserAndNumber.set(key, vendor.id);
  }
}

let updated = 0;
let parsedFromPdf = 0;
let noMatch = 0;

for (const analysis of analyses) {
  let normalized = normalizeVendorNumber(analysis.vendor_number);
  if (!normalized) {
    const filePath = filePathById.get(analysis.file_id);
    if (filePath) {
      const download = await supabase.storage.from("uploads").download(filePath);
      if (!download.error && download.data) {
        const buffer = Buffer.from(await download.data.arrayBuffer());
        const text = extractPdfText(buffer);
        normalized = extractVendorNumberFromPdf(text);
        if (normalized) parsedFromPdf += 1;
      }
    }
  }

  if (!normalized) {
    noMatch += 1;
    continue;
  }

  const key = `${analysis.user_id}:${normalized}`;
  const vendorId = vendorIdByUserAndNumber.get(key);
  if (!vendorId) {
    noMatch += 1;
    continue;
  }

  const updateResult = await supabase
    .from("boleta_analyses")
    .update({ vendor_id: vendorId, vendor_number: normalized })
    .eq("id", analysis.id);

  if (!updateResult.error) {
    updated += 1;
  }
}

console.log(
  JSON.stringify({
    pending: analyses.length,
    updated,
    parsedFromPdf,
    noMatch,
  }),
);
