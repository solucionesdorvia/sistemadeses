import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4.2.0";

import { corsHeaders } from "../_shared/cors.ts";
import { getRequestUserId } from "../_shared/auth.ts";

type RequestBody = {
  module: "cuentas_corrientes" | "boletas";
  specific_vendor?: string;
  send_all?: boolean;
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const userId = await getRequestUserId(request);
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) throw new Error("RESEND_API_KEY no configurado.");
    const resend = new Resend(apiKey);

    const body = (await request.json()) as RequestBody;
    const vendors = await resolveVendors(
      userId,
      body.specific_vendor,
      body.send_all ?? false,
    );
    if (vendors.length === 0) {
      return json({ ok: false, message: "No hay vendedores con email configurado." }, 404);
    }

    const results: Array<{ vendor: string; sent: boolean; reason?: string }> = [];
    for (const vendor of vendors) {
      try {
        const attachments = await loadVendorAttachments(
          userId,
          vendor.normalized_name,
          vendor.convert_to_pdf,
          body.module,
          vendor.vendor_number,
        );

        if (!attachments.length) {
          results.push({ vendor: vendor.normalized_name, sent: false, reason: "No files found." });
          continue;
        }

        await resend.emails.send({
          from: "cuentas@corrientes11.com",
          to: vendor.email!,
          subject:
            body.module === "boletas"
              ? "Boletas disponibles"
              : "Cuentas Corrientes actualizadas",
          html: `<p>Adjuntamos ${attachments.length} archivo(s).</p>`,
          attachments,
        });

        results.push({ vendor: vendor.normalized_name, sent: true });
      } catch (error) {
        results.push({
          vendor: vendor.normalized_name,
          sent: false,
          reason: error instanceof Error ? error.message : "Error inesperado",
        });
      }
    }

    return json({ ok: true, results });
  } catch (error) {
    return json(
      { message: error instanceof Error ? error.message : "No se pudo enviar emails." },
      500,
    );
  }
});

async function resolveVendors(
  userId: string,
  specificVendor: string | undefined,
  sendAll: boolean,
) {
  let query = supabase
    .from("vendors")
    .select("*")
    .eq("user_id", userId)
    .not("email", "is", null);
  if (specificVendor && !sendAll) {
    query = query.eq("normalized_name", specificVendor);
  }
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

async function loadVendorAttachments(
  userId: string,
  vendorName: string,
  convertToPdf: boolean,
  moduleType: "cuentas_corrientes" | "boletas",
  vendorNumber?: string | null,
) {
  if (moduleType === "boletas") {
    return loadBoletasAttachments(userId, vendorNumber);
  }

  const folder = vendorName.toLowerCase().replace(/\s+/g, "-");
  const baseFolder = `${userId}/vendedores/${folder}`;
  const listed = await supabase.storage.from("results").list(baseFolder, { limit: 1000 });
  if (listed.error) throw new Error(listed.error.message);

  const filtered = (listed.data ?? []).filter((item) =>
    convertToPdf ? item.name.endsWith(".pdf") : item.name.endsWith(".xlsx"),
  );

  const attachments = [];
  for (const file of filtered) {
    const path = `${baseFolder}/${file.name}`;
    const downloaded = await supabase.storage.from("results").download(path);
    if (downloaded.error || !downloaded.data) continue;
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    attachments.push({
      filename: file.name,
      content: base64FromBytes(bytes),
    });
  }
  return attachments;
}

async function loadBoletasAttachments(userId: string, vendorNumber?: string | null) {
  if (!vendorNumber) return [];
  const analyses = await supabase
    .from("boleta_analyses")
    .select("file:files(file_path, original_filename)")
    .eq("user_id", userId)
    .eq("vendor_number", vendorNumber);

  if (analyses.error) throw new Error(analyses.error.message);

  const attachments = [];
  for (const row of analyses.data ?? []) {
    const filePath = (row as { file: { file_path: string; original_filename: string | null } }).file
      ?.file_path;
    if (!filePath) continue;
    const downloaded = await supabase.storage.from("uploads").download(filePath);
    if (downloaded.error || !downloaded.data) continue;
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    attachments.push({
      filename: filePath.split("/").pop() ?? "boleta.pdf",
      content: base64FromBytes(bytes),
    });
  }
  return attachments;
}

function base64FromBytes(bytes: Uint8Array) {
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
