"use server";

import { revalidatePath } from "next/cache";

import { ROUTES } from "@/lib/config/app";
import { createVendorSchema, vendorConfigSchema } from "@/lib/validations/vendor";
import {
  createVendor,
  listVendors,
  upsertVendorConfig,
} from "@/modules/vendors/services/vendors-service";

export async function listVendorsAction() {
  const result = await listVendors();
  if (result.error) {
    throw new Error(result.error.message);
  }
  return result.data ?? [];
}

export async function updateVendorConfigAction(
  vendorId: string,
  rawPayload: unknown,
) {
  const payload = vendorConfigSchema.parse(rawPayload);
  const result = await upsertVendorConfig(vendorId, payload);

  if (result.error) {
    throw new Error(result.error.message);
  }

  revalidatePath(ROUTES.cuentasCorrientes);
  revalidatePath(ROUTES.boletas);
  return result.data;
}

export async function createVendorAction(rawPayload: unknown) {
  const payload = createVendorSchema.parse(rawPayload);
  const result = await createVendor(payload);

  if (result.error) {
    throw new Error(result.error.message);
  }

  revalidatePath(ROUTES.cuentasCorrientes);
  revalidatePath(ROUTES.boletas);
  return result.data;
}
