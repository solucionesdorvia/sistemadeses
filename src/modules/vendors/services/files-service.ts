import type { BoletaAnalysisRow, FileRow } from "@/lib/types/database";
import type { FileRecord } from "@/lib/types/domain";
import { createClient } from "@/lib/supabase/server";

function mapFileRow(
  row: FileRow,
  vendorsFoundCount: number,
  boletaVendorNumber: string | null = null,
): FileRecord {
  return {
    id: row.id,
    userId: row.user_id,
    module: row.module,
    companyType: row.company_type,
    status: row.status,
    filePath: row.file_path,
    vendorFolderPath: row.vendor_folder_path,
    vendorsFoundCount,
    boletaVendorNumber,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCuentaCorrienteFiles() {
  const supabase = await createClient();
  const result = await supabase
    .from("files")
    .select("*")
    .eq("module", "cuentas_corrientes")
    .order("created_at", { ascending: false });

  if (result.error) return { data: null, error: result.error };

  const files = (result.data as FileRow[]) ?? [];
  const fileIds = files.map((row) => row.id);
  const vendorsByFileId = new Map<string, number>();

  if (fileIds.length > 0) {
    const processResult = await supabase
      .from("processes")
      .select("file_id,records_processed")
      .in("file_id", fileIds);

    if (!processResult.error && processResult.data) {
      for (const row of processResult.data) {
        const fileId = String(row.file_id ?? "");
        if (!fileId) continue;
        const current = vendorsByFileId.get(fileId) ?? 0;
        const next = Number(row.records_processed ?? 0);
        vendorsByFileId.set(fileId, Math.max(current, next));
      }
    }
  }

  return {
    data: files.map((row) => mapFileRow(row, vendorsByFileId.get(row.id) ?? 0)),
    error: null,
  };
}

export async function listBoletaFiles() {
  const supabase = await createClient();
  const result = await supabase
    .from("files")
    .select("*")
    .eq("module", "boletas")
    .order("created_at", { ascending: false });

  if (result.error) return { data: null, error: result.error };

  const files = (result.data as FileRow[]) ?? [];
  const fileIds = files.map((file) => file.id);
  const vendorNumberByFileId = new Map<string, string | null>();

  if (fileIds.length > 0) {
    const analysesResult = await supabase
      .from("boleta_analyses")
      .select("file_id,vendor_number,created_at")
      .in("file_id", fileIds)
      .order("created_at", { ascending: false });

    if (!analysesResult.error && analysesResult.data) {
      for (const analysis of analysesResult.data as Pick<
        BoletaAnalysisRow,
        "file_id" | "vendor_number" | "created_at"
      >[]) {
        const fileId = analysis.file_id;
        if (!fileId || vendorNumberByFileId.has(fileId)) continue;
        vendorNumberByFileId.set(fileId, normalizeVendorNumber(analysis.vendor_number));
      }
    }
  }

  return {
    data: files.map((row) => mapFileRow(row, 0, vendorNumberByFileId.get(row.id) ?? null)),
    error: null,
  };
}

export async function listBoletasGroupedByVendor() {
  const supabase = await createClient();
  const result = await supabase
    .from("boleta_analyses")
    .select(
      "id,vendor_number,file:files(id,file_path,created_at,status),vendor:vendors(id,normalized_name,email,vendor_number)",
    )
    .order("created_at", { ascending: false });

  if (result.error) return { data: null, error: result.error };
  return { data: result.data, error: null };
}

function normalizeVendorNumber(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const explicitMatch = trimmed.match(/(?:vend(?:edor)?\.?\s*:?\s*)(\d{1,8})/i);
  if (explicitMatch?.[1]) {
    return explicitMatch[1].replace(/^0+/, "").trim() || "0";
  }

  const tokens = trimmed.match(/\d+/g) ?? [];
  if (tokens.length === 1) {
    return tokens[0].replace(/^0+/, "").trim() || "0";
  }

  const digitsOnly = trimmed.replace(/[^\d]/g, "");
  return digitsOnly ? digitsOnly.replace(/^0+/, "").trim() || "0" : null;
}
