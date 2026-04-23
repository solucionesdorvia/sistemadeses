import { createClient as createAdminClient } from "@supabase/supabase-js";

import { getClientEnv, getServerEnv } from "@/lib/config/env";
import { getMicrosoftGraphPdfConfig } from "@/lib/microsoft-graph/config";
import { convertXlsxToPdfWithGraph } from "@/lib/microsoft-graph/convertXlsxToPdfWithGraph";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Body = {
  companyType?: "americana" | "days" | "desesplast";
  vendorName?: string;
};

/**
 * Cuentas corrientes: XLSX (storage) -> PDF vía **Microsoft Graph**
 * (Excel Online renderiza: máxima fidelidad frente a LibreOffice en servidor).
 * Requiere variables de entorno Microsoft 365; ver `getMicrosoftGraphPdfConfig`.
 */
export async function POST(request: Request) {
  try {
    const graphConfig = getMicrosoftGraphPdfConfig();
    if (!graphConfig) {
      return Response.json({
        ok: false,
        converted: 0,
        errors: [],
        message:
          "Microsoft Graph no configurado. Definir MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_GRAPH_USER_ID (y opcionalmente MICROSOFT_PDF_TEMP_FOLDER).",
      });
    }

    const authClient = await createClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return Response.json({ message: "Sesion invalida." }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as Body;
    const { NEXT_PUBLIC_SUPABASE_URL } = getClientEnv();
    const serverEnv = getServerEnv();
    const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv;

    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return Response.json(
        { message: "SUPABASE_SERVICE_ROLE_KEY no configurado." },
        { status: 500 },
      );
    }

    const admin = createAdminClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const vendorsResult = await admin
      .from("vendors")
      .select("normalized_name,canonical_name,convert_to_pdf")
      .eq("user_id", user.id);

    if (vendorsResult.error) {
      return Response.json({ message: vendorsResult.error.message }, { status: 500 });
    }

    let converted = 0;
    const errors: Array<{ vendor: string; file: string; reason: string }> = [];
    const companySuffix = body.companyType ? `_${body.companyType}.xlsx` : ".xlsx";

    const normalizedTarget = body.vendorName?.trim().toLowerCase() ?? null;
    const selectedVendors = (vendorsResult.data ?? []).filter((vendor) => {
      const matchesByName = normalizedTarget
        ? vendor.normalized_name.toLowerCase() === normalizedTarget ||
          (vendor.canonical_name ?? "").toLowerCase() === normalizedTarget
        : true;
      if (!matchesByName) return false;
      return normalizedTarget ? true : Boolean(vendor.convert_to_pdf);
    });

    for (const vendor of selectedVendors) {
      const displayName = vendor.canonical_name ?? vendor.normalized_name;
      const safeFolder = pathSafeVendorName(displayName);
      const baseFolder = `${user.id}/vendedores/${safeFolder}`;

      const listed = await admin.storage.from("results").list(baseFolder, { limit: 1000 });
      if (listed.error) {
        errors.push({
          vendor: displayName,
          file: baseFolder,
          reason: listed.error.message,
        });
        continue;
      }

      const targets = (listed.data ?? []).filter((file) => {
        return body.companyType ? file.name.endsWith(companySuffix) : file.name.endsWith(".xlsx");
      });

      for (const file of targets) {
        const filePath = `${baseFolder}/${file.name}`;
        try {
          const downloaded = await admin.storage.from("results").download(filePath);
          if (downloaded.error || !downloaded.data) {
            throw new Error(downloaded.error?.message ?? "No se pudo descargar XLSX.");
          }

          const sourceBytes = new Uint8Array(await downloaded.data.arrayBuffer());
          let pdfBytes: Buffer;
          try {
            pdfBytes = await convertXlsxToPdfWithGraph(sourceBytes, file.name, graphConfig);
          } catch (err) {
            throw new Error(
              err instanceof Error ? err.message : "Error al convertir con Microsoft Graph.",
            );
          }

          const pdfPath = filePath.replace(/\.xlsx$/i, ".pdf");
          const uploaded = await admin.storage.from("results").upload(pdfPath, pdfBytes, {
            upsert: true,
            contentType: "application/pdf",
          });
          if (uploaded.error) {
            throw new Error(uploaded.error.message);
          }
          converted += 1;
        } catch (error) {
          errors.push({
            vendor: displayName,
            file: file.name,
            reason: error instanceof Error ? error.message : "Error al convertir.",
          });
        }
      }
    }

    return Response.json({
      ok: true,
      converted,
      errors,
    });
  } catch (error) {
    return Response.json(
      { message: error instanceof Error ? error.message : "Error inesperado." },
      { status: 500 },
    );
  }
}

function pathSafeVendorName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}
