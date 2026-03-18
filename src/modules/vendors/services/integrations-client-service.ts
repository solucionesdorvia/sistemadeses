"use client";

import { createClient } from "@/lib/supabase/client";
import { invokeEdgeFunction } from "@/modules/vendors/services/edge-client-service";

export async function sendVendorEmails(params: {
  module: "cuentas_corrientes" | "boletas";
  specificVendor?: string;
  sendAll?: boolean;
}) {
  await invokeEdgeFunction({
    functionName: "send-vendor-emails",
    body: {
      module: params.module,
      specific_vendor: params.specificVendor,
      send_all: params.sendAll ?? false,
    },
  });
}

export async function syncGoogleDrive(vendorName?: string) {
  await invokeEdgeFunction({
    functionName: "sync-google-drive",
    body: vendorName ? { vendor_name: vendorName } : {},
  });
}

export async function disconnectGoogleDrive() {
  const supabase = createClient();
  const result = await supabase.from("google_oauth_tokens").delete().neq("id", "");
  if (result.error) throw new Error(result.error.message);
}
