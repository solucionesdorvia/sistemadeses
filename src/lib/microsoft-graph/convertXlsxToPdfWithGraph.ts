import { randomUUID } from "node:crypto";

import type { MicrosoftGraphPdfConfig } from "@/lib/microsoft-graph/config";

const GRAPH = "https://graph.microsoft.com/v1.0";

type TokenResult = { access_token: string; expires_in: number };

/**
 * Sube un .xlsx a OneDrive (usuario de servicio), descarga con
 * GET /content?format=pdf (render Excel Online) y borra el item.
 * @see https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format
 */
export async function convertXlsxToPdfWithGraph(
  xlsx: Uint8Array,
  fileName: string,
  config: MicrosoftGraphPdfConfig,
): Promise<Buffer> {
  const token = await getAppOnlyAccessToken(config);
  const userSegment = encodeURIComponent(config.userIdOrUpn);
  const safeLocalName = safeStorageFileName(fileName);
  const unique = `${randomUUID()}-${safeLocalName}`;
  const relPath = `${config.tempFolder}/${unique}`;

  const putUrl = `${GRAPH}/users/${userSegment}/drive/root:/${encodePathSegments(relPath)}:/content`;
  const put = await fetch(putUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    body: Buffer.from(xlsx),
  });

  if (!put.ok) {
    const t = await put.text();
    throw new Error(
      `[Graph] Subida de XLSX fallo: ${put.status} ${t.slice(0, 500)}`,
    );
  }
  const created = (await put.json()) as { id: string };
  if (!created?.id) {
    throw new Error("[Graph] La subida no devolvio id del item.");
  }

  try {
    return await downloadItemAsPdf(userSegment, created.id, token);
  } finally {
    const del = await fetch(`${GRAPH}/users/${userSegment}/drive/items/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!del.ok) {
      console.error("[Graph] No se pudo borrar item temporal", del.status, await del.text());
    }
  }
}

function encodePathSegments(relPath: string) {
  return relPath
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}

function safeStorageFileName(name: string) {
  const base = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return base.length > 0 && base.length <= 200 ? base : "workbook.xlsx";
}

async function getAppOnlyAccessToken(config: MicrosoftGraphPdfConfig): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`[Graph] Token: ${res.status} ${t.slice(0, 300)}`);
  }
  const json = (await res.json()) as TokenResult;
  if (!json.access_token) {
    throw new Error("[Graph] Respuesta de token invalida.");
  }
  return json.access_token;
}

/**
 * devuelve 302 a URL firmada: seguir a la Location sin Authorization
 */
async function downloadItemAsPdf(
  userSegment: string,
  itemId: string,
  token: string,
): Promise<Buffer> {
  const url = `${GRAPH}/users/${userSegment}/drive/items/${itemId}/content?format=pdf`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });

  if (res.status === 302 || res.status === 301) {
    const loc = res.headers.get("location");
    if (!loc) {
      throw new Error("[Graph] PDF: redireccion sin Location.");
    }
    const pdf = await fetch(loc, { method: "GET" });
    if (!pdf.ok) {
      const t = await pdf.text();
      throw new Error(`[Graph] Descarga PDF: ${pdf.status} ${t.slice(0, 200)}`);
    }
    return Buffer.from(await pdf.arrayBuffer());
  }

  if (res.ok) {
    return Buffer.from(await res.arrayBuffer());
  }

  const t = await res.text();
  throw new Error(`[Graph] PDF: ${res.status} ${t.slice(0, 500)}`);
}
