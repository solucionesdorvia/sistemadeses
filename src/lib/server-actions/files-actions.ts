"use server";

import { revalidatePath } from "next/cache";

import { ROUTES } from "@/lib/config/app";
import { createClient } from "@/lib/supabase/server";
import {
  listBoletaFiles,
  listBoletasGroupedByVendor,
  listCuentaCorrienteFiles,
} from "@/modules/vendors/services/files-service";

export async function listCuentaCorrienteFilesAction() {
  const result = await listCuentaCorrienteFiles();
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

export async function listBoletasFilesAction() {
  const result = await listBoletaFiles();
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

export async function listBoletasByVendorAction() {
  const result = await listBoletasGroupedByVendor();
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

export async function createFileRecordAction(payload: {
  module: "cuentas_corrientes" | "boletas";
  companyType?: "americana" | "days" | "desesplast";
  filePath: string;
  status?: "pending" | "processing" | "completed" | "error";
  originalFilename?: string;
}) {
  const supabase = await createClient();
  const result = await supabase
    .from("files")
    .insert({
      module: payload.module,
      company_type: payload.companyType ?? null,
      file_path: payload.filePath,
      status: payload.status ?? "pending",
      original_filename: payload.originalFilename ?? null,
    })
    .select("id")
    .single();

  if (result.error) {
    throw new Error(result.error.message);
  }

  revalidatePath(ROUTES.cuentasCorrientes);
  revalidatePath(ROUTES.boletas);
  return result.data.id as string;
}
