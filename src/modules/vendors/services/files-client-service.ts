"use client";

import { createClient } from "@/lib/supabase/client";
import type { CompanyType } from "@/lib/types/domain";
import JSZip from "jszip";
import { invokeEdgeFunction } from "@/modules/vendors/services/edge-client-service";

type ConvertPdfResponse = {
  ok: boolean;
  converted: number;
  errors: Array<{ vendor: string; file: string; reason: string }>;
  message?: string;
};

export async function uploadCuentaCorrienteFiles(
  files: File[],
  companyType: CompanyType,
) {
  const invalid = files.filter((file) => {
    const lower = file.name.toLowerCase();
    return !lower.endsWith(".xlsx") && !lower.endsWith(".xls");
  });
  if (invalid.length > 0) {
    throw new Error("Solo se aceptan archivos .xlsx o .xls.");
  }

  const supabase = createClient();
  const uploadedPaths: string[] = [];

  try {
    for (const originalFile of files) {
      const file = await normalizeCuentaCorrienteInputFile(originalFile);
      const path = `cuentas-corrientes/${crypto.randomUUID()}-${file.name}`;
      const upload = await supabase.storage.from("uploads").upload(path, file, {
        upsert: false,
      });

      if (upload.error) {
        throw new Error(upload.error.message);
      }

      const fileInsert = await supabase.from("files").insert({
        module: "cuentas_corrientes",
        company_type: companyType,
        file_path: path,
        original_filename: file.name,
        status: "pending",
      });

      if (fileInsert.error) {
        throw new Error(fileInsert.error.message);
      }

      uploadedPaths.push(path);
    }

    const processResponse = await fetch("/api/cuentas-corrientes/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyType, filePaths: uploadedPaths }),
    });
    if (!processResponse.ok) {
      const payload = (await processResponse.json().catch(() => ({}))) as { message?: string };
      throw new Error(payload.message ?? "Error al procesar cuentas corrientes.");
    }

    // Conversion local opcional a PDF para vendedores con "convertToPdf = true".
    const convertPayload = await triggerPdfConversion({ companyType });
    if (!convertPayload.ok) {
      console.warn(
        "[convert-pdf] No se pudo convertir a PDF, el XLSX permanece disponible:",
        convertPayload.message ?? "Error desconocido",
      );
    } else if (convertPayload.errors.length > 0) {
      console.warn(
        "[convert-pdf] Conversion parcial con errores:",
        convertPayload.errors.map((item) => `${item.vendor}: ${item.reason}`).join(" | "),
      );
    }
  } catch (error) {
    if (uploadedPaths.length > 0) {
      await supabase
        .from("files")
        .update({
          status: "error",
          error_message:
            error instanceof Error
              ? error.message
              : "Error al invocar procesamiento de cuentas corrientes.",
        })
        .in("file_path", uploadedPaths)
        .in("status", ["pending", "processing"]);
    }
    throw error;
  }
}

async function normalizeCuentaCorrienteInputFile(file: File) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    return file;
  }

  if (!lower.endsWith(".xls")) {
    throw new Error(`Formato no soportado: ${file.name}`);
  }

  // Conversion en backend con LibreOffice para preservar formato de .xls
  // mucho mejor que una conversion JS en navegador.
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/cuentas-corrientes/convert-xls", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(payload.message ?? "No se pudo convertir .xls a .xlsx.");
  }

  const convertedBuffer = await response.arrayBuffer();
  const convertedNameHeader = response.headers.get("X-Converted-Filename");
  const convertedName = convertedNameHeader || file.name.replace(/\.xls$/i, ".xlsx");

  return new File([convertedBuffer], convertedName, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    lastModified: Date.now(),
  });
}

export async function triggerPdfConversion(params: {
  companyType?: CompanyType;
  vendorName?: string;
}) {
  const convertResponse = await fetch("/api/cuentas-corrientes/convert-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      companyType: params.companyType,
      vendorName: params.vendorName,
    }),
  });

  const payload = (await convertResponse.json().catch(() => ({}))) as ConvertPdfResponse;
  if (!convertResponse.ok) {
    throw new Error(payload.message ?? "No se pudo convertir a PDF.");
  }

  return payload;
}

export async function uploadBoletasFiles(files: File[]) {
  const supabase = createClient();
  const uploadedPaths: string[] = [];

  for (const file of files) {
    const path = `boletas/${crypto.randomUUID()}-${file.name}`;
    const upload = await supabase.storage.from("uploads").upload(path, file, {
      upsert: false,
    });

    if (upload.error) {
      throw new Error(upload.error.message);
    }

    const fileInsert = await supabase.from("files").insert({
      module: "boletas",
      file_path: path,
      original_filename: file.name,
      status: "pending",
    });

    if (fileInsert.error) {
      throw new Error(fileInsert.error.message);
    }

    uploadedPaths.push(path);
  }

  await invokeEdgeFunction({
    functionName: "process-boletas",
    body: { filePaths: uploadedPaths },
  });
}

export async function listVendorResultFiles(vendorName: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sesion invalida.");

  const folder = vendorName.toLowerCase().replace(/\s+/g, "-");
  const path = `${user.id}/vendedores/${folder}`;
  const listed = await supabase.storage.from("results").list(path, { limit: 1000 });
  if (listed.error) throw new Error(listed.error.message);

  return (listed.data ?? [])
    .filter((item) => item.name !== ".emptyFolderPlaceholder")
    .map((item) => ({
      name: item.name,
      path: `${path}/${item.name}`,
    }));
}

export async function downloadResultFile(path: string) {
  const supabase = createClient();
  const response = await supabase.storage.from("results").download(path);
  if (response.error || !response.data) {
    throw new Error(response.error?.message ?? "No se pudo descargar archivo.");
  }

  const url = URL.createObjectURL(response.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() ?? "archivo";
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadVendorZip(paths: string[], zipName: string) {
  if (!paths.length) throw new Error("No hay archivos para descargar.");
  const supabase = createClient();
  const zip = new JSZip();

  for (const path of paths) {
    const response = await supabase.storage.from("results").download(path);
    if (response.error || !response.data) continue;
    zip.file(path.split("/").pop() ?? path, response.data);
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${zipName}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadUploadedFile(path: string) {
  const supabase = createClient();
  const response = await supabase.storage.from("uploads").download(path);
  if (response.error || !response.data) {
    throw new Error(response.error?.message ?? "No se pudo descargar archivo subido.");
  }

  const url = URL.createObjectURL(response.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() ?? "boleta.pdf";
  a.click();
  URL.revokeObjectURL(url);
}

export async function clearAllVendorResultFiles() {
  try {
    return await invokeEdgeFunction<{ deletedCount: number }>({
      functionName: "clear-vendor-results",
      body: {},
    });
  } catch {
    return await clearAllVendorResultFilesClientFallback();
  }
}

async function clearAllVendorResultFilesClientFallback() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sesion invalida.");

  const basePath = `${user.id}/vendedores`;
  const root = await supabase.storage.from("results").list(basePath, { limit: 1000 });
  if (root.error) throw new Error(root.error.message);

  const folders = (root.data ?? []).map((entry) => entry.name);
  const nestedEntries = await runWithConcurrency(folders, 8, async (folder) => {
    const folderPath = `${basePath}/${folder}`;
    const nested = await supabase.storage.from("results").list(folderPath, { limit: 1000 });
    if (nested.error) throw new Error(nested.error.message);
    return (nested.data ?? []).map((file) => ({
      folder,
      name: file.name,
    }));
  });

  const toDelete = nestedEntries
    .flat()
    .filter((entry) => entry.name !== ".emptyFolderPlaceholder")
    .map((entry) => `${basePath}/${entry.folder}/${entry.name}`);

  if (toDelete.length > 0) {
    const chunks = chunkArray(toDelete, 250);
    await runWithConcurrency(chunks, 4, async (batch) => {
      const deleted = await supabase.storage.from("results").remove(batch);
      if (deleted.error) throw new Error(deleted.error.message);
    });
  }

  await runWithConcurrency(folders, 8, async (folder) => {
    const placeholderPath = `${basePath}/${folder}/.emptyFolderPlaceholder`;
    const uploaded = await supabase.storage.from("results").upload(placeholderPath, new Blob([""]), {
      upsert: true,
      contentType: "text/plain",
    });
    if (uploaded.error) throw new Error(uploaded.error.message);
  });

  return { deletedCount: toDelete.length };
}

function chunkArray<T>(source: T[], chunkSize: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < source.length; index += chunkSize) {
    chunks.push(source.slice(index, index + chunkSize));
  }
  return chunks;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: safeConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}
