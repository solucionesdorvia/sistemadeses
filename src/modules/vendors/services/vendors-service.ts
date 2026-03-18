import type { PostgrestError } from "@supabase/supabase-js";

import type { Vendor } from "@/lib/types/domain";
import type { VendorRow } from "@/lib/types/database";
import type {
  CreateVendorSchema,
  VendorConfigSchema,
} from "@/lib/validations/vendor";
import { createClient } from "@/lib/supabase/server";
import { mapVendorRow } from "@/modules/vendors/types/mappers";

type ServiceResult<T> = {
  data: T | null;
  error: PostgrestError | Error | null;
};

export async function listVendors(): Promise<ServiceResult<Vendor[]>> {
  const supabase = await createClient();
  const result = await supabase
    .from("vendors")
    .select("*")
    .order("normalized_name", { ascending: true });

  if (result.error) return { data: null, error: result.error };

  return {
    data: (result.data as VendorRow[]).map(mapVendorRow),
    error: null,
  };
}

export async function upsertVendorConfig(
  vendorId: string,
  payload: VendorConfigSchema,
): Promise<ServiceResult<Vendor>> {
  const supabase = await createClient();
  const updatePayload: {
    email: string | null;
    drive_folder_id: string | null;
    convert_to_pdf: boolean;
    vendor_number?: string | null;
  } = {
    email: payload.email || null,
    drive_folder_id: payload.driveFolderId || null,
    convert_to_pdf: payload.convertToPdf,
  };

  if (payload.vendorNumber !== undefined) {
    updatePayload.vendor_number = payload.vendorNumber || null;
  }

  const result = await supabase
    .from("vendors")
    .update(updatePayload)
    .eq("id", vendorId)
    .select("*")
    .single();

  if (result.error) return { data: null, error: result.error };

  return { data: mapVendorRow(result.data as VendorRow), error: null };
}

export async function createVendor(
  payload: CreateVendorSchema,
): Promise<ServiceResult<Vendor>> {
  const supabase = await createClient();
  const result = await supabase
    .from("vendors")
    .insert({
      normalized_name: payload.normalizedName,
      original_name: payload.normalizedName,
      company_type: payload.companyType,
      vendor_number: payload.vendorNumber || null,
      email: payload.email || null,
    })
    .select("*")
    .single();

  if (result.error) return { data: null, error: result.error };

  return { data: mapVendorRow(result.data as VendorRow), error: null };
}
