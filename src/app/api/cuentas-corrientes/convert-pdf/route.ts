import { createClient as createAdminClient } from "@supabase/supabase-js";

import { getClientEnv, getServerEnv } from "@/lib/config/env";
import { convertXlsxToPdf } from "@/lib/libreoffice/convertXlsxToPdf";
import { createClient } from "@/lib/supabase/server";
import { pathSafeVendorName } from "@/lib/vendors/pathSafeVendorName";

export const runtime = "nodejs";

type Body = {
  companyType?: "americana" | "days" | "desesplast";
  vendorName?: string;
};

/**
 * Cuentas corrientes: XLSX → PDF. LibreOffice si está disponible; si no, PDF de
 * respaldo (tabla con pdf-lib) para que no quede en cero.
 */
export async function POST(request: Request) {
  try {
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
    let xlsxFound = 0;
    const errors: Array<{ vendor: string; file: string; reason: string }> = [];
    const companySuffix = body.companyType ? `_${body.companyType}.xlsx` : ".xlsx";

    console.log(
      `[convert-pdf] inicio companyType=${body.companyType ?? "(todos)"} vendorName=${body.vendorName ?? "(todos)"} userId=${user.id}`,
    );

    const normalizedTarget = body.vendorName?.trim().toLowerCase() ?? null;
    // Tras subir por empresa, siempre se pasa `companyType`: convertir para todos
    // los vendedores con XLSX de ese lote, sin exigir `convert_to_pdf` (el flag
    // sigue valiendo para email/Drive y llamadas sin companyType ni vendorName).
    const scopeFromUpload = Boolean(body.companyType || body.vendorName);
    const selectedVendors = (vendorsResult.data ?? []).filter((vendor) => {
      const matchesByName = normalizedTarget
        ? vendor.normalized_name.toLowerCase() === normalizedTarget ||
          (vendor.canonical_name ?? "").toLowerCase() === normalizedTarget
        : true;
      if (!matchesByName) return false;
      if (scopeFromUpload) return true;
      return Boolean(vendor.convert_to_pdf);
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
      xlsxFound += targets.length;
      if (targets.length === 0) {
        console.log(
          `[convert-pdf] vendor=${displayName} baseFolder=${baseFolder} sin xlsx (listado.data=${listed.data?.length ?? 0} files; companySuffix=${companySuffix})`,
        );
      }

      for (const file of targets) {
        const filePath = `${baseFolder}/${file.name}`;
        try {
          const downloaded = await admin.storage.from("results").download(filePath);
          if (downloaded.error || !downloaded.data) {
            throw new Error(downloaded.error?.message ?? "No se pudo descargar XLSX.");
          }

          const sourceBytes = new Uint8Array(await downloaded.data.arrayBuffer());
          const pdfBytes = await convertXlsxToPdf(sourceBytes, file.name);

          const pdfPath = filePath.replace(/\.xlsx$/i, ".pdf");
          const uploaded = await admin.storage.from("results").upload(pdfPath, pdfBytes, {
            upsert: true,
            contentType: "application/pdf",
          });
          if (uploaded.error) {
            throw new Error(uploaded.error.message);
          }
          console.log(`[convert-pdf] vendor=${displayName} file=${file.name} OK (${pdfBytes.length} bytes)`);
          converted += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Error al convertir.";
          console.error(`[convert-pdf] vendor=${displayName} file=${file.name} FALLO:`, reason);
          errors.push({
            vendor: displayName,
            file: file.name,
            reason,
          });
        }
      }
    }

    let message: string | undefined;
    if (selectedVendors.length === 0) {
      message =
        "No hay vendedores para convertir. Con ambito restringido, revisa el nombre; sin companyType/vendorName hace falta 'PDF' activo en vendedor.";
    } else if (xlsxFound === 0) {
      message = `Cero XLSX encontrados para ${selectedVendors.length} vendedores. Sufijo buscado: ${companySuffix}. Revisar paths en results/.../vendedores/.`;
    } else if (converted === 0 && errors.length === 0) {
      message = "Ningun archivo .xlsx coincidente en resultados (carpeta de vendedor / sufijo de empresa).";
    }

    console.log(
      `[convert-pdf] fin vendedores=${selectedVendors.length} xlsxFound=${xlsxFound} converted=${converted} errors=${errors.length}`,
    );

    return Response.json({
      ok: true,
      converted,
      vendorsScanned: selectedVendors.length,
      xlsxFound,
      errors,
      ...(message ? { message } : {}),
    });
  } catch (error) {
    return Response.json(
      { message: error instanceof Error ? error.message : "Error inesperado." },
      { status: 500 },
    );
  }
}
