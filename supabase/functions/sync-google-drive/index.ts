import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";
import { getRequestUserId } from "../_shared/auth.ts";

type RequestBody = { vendor_name?: string };

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
    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const vendorsResult = await supabase
      .from("vendors")
      .select("normalized_name, canonical_name, drive_folder_id, convert_to_pdf")
      .eq("user_id", userId)
      .not("drive_folder_id", "is", null);

    if (vendorsResult.error) throw new Error(vendorsResult.error.message);

    const candidates = (vendorsResult.data ?? []).filter((vendor) =>
      body.vendor_name ? vendor.normalized_name === body.vendor_name : true,
    );

    const googleToken = await getGoogleAccessToken(userId);

    if (!googleToken) {
      return json({ needsOAuth: true, message: "No hay OAuth ni Service Account." }, 401);
    }

    const synced: Array<{ vendor: string; uploaded: number }> = [];

    for (const vendor of candidates) {
      const folderId = extractFolderId(vendor.drive_folder_id!);
      if (!folderId) continue;

      const storageFolder = (vendor.canonical_name ?? vendor.normalized_name)
        .toLowerCase()
        .replace(/\s+/g, "-");
      const storageBasePath = `${userId}/vendedores/${storageFolder}`;

      const storageList = await supabase.storage.from("results").list(storageBasePath, {
        limit: 1000,
      });
      if (storageList.error) throw new Error(storageList.error.message);

      const files = (storageList.data ?? []).filter((file) =>
        vendor.convert_to_pdf ? file.name.endsWith(".pdf") : file.name.endsWith(".xlsx"),
      );

      await purgeDriveFolder(folderId, googleToken);
      let uploaded = 0;
      for (const file of files) {
        const path = `${storageBasePath}/${file.name}`;
        const download = await supabase.storage.from("results").download(path);
        if (download.error || !download.data) continue;
        const bytes = new Uint8Array(await download.data.arrayBuffer());
        await uploadToDrive(folderId, file.name, bytes, googleToken);
        uploaded += 1;
      }
      synced.push({ vendor: vendor.normalized_name, uploaded });
    }

    return json({ ok: true, synced });
  } catch (error) {
    return json(
      { message: error instanceof Error ? error.message : "Error de sincronizacion." },
      500,
    );
  }
});

async function purgeDriveFolder(folderId: string, token: string) {
  const listed = await fetch(
    `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name)`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (listed.status === 403) throw new Error("Sin permisos para la carpeta en Drive (403).");
  if (listed.status === 404) throw new Error("Carpeta de Drive no encontrada (404).");
  if (!listed.ok) throw new Error("No se pudo listar contenido de Drive.");
  const payload = (await listed.json()) as { files?: Array<{ id: string }> };

  for (const file of payload.files ?? []) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}

async function uploadToDrive(
  folderId: string,
  fileName: string,
  content: Uint8Array,
  token: string,
) {
  const metadata = { name: fileName, parents: [folderId] };
  const formData = new FormData();
  formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  formData.append("file", new Blob([content]));

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    },
  );
  if (!response.ok) {
    throw new Error(`Fallo upload a Drive (${response.status}).`);
  }
}

async function serviceAccountToken() {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) return null;
  // NOTE: este fallback requiere firma JWT completa; se deja explicitado para deploy seguro.
  throw new Error(
    "Service Account fallback requiere implementacion JWT completa en runtime edge.",
  );
}

async function getGoogleAccessToken(userId: string) {
  const oauthResult = await supabase
    .from("google_oauth_tokens")
    .select("*")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (oauthResult.error) {
    throw new Error(oauthResult.error.message);
  }

  const oauth = oauthResult.data;
  if (!oauth) {
    return serviceAccountToken().catch(() => null);
  }

  const expiresAt = oauth.expires_at ? new Date(oauth.expires_at).getTime() : null;
  const aboutToExpire = expiresAt ? expiresAt - Date.now() < 5 * 60 * 1000 : false;

  if (!aboutToExpire) {
    return oauth.access_token as string;
  }

  if (!oauth.refresh_token) {
    return oauth.access_token as string;
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET faltantes para refresh token.");
  }

  const refresh = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: oauth.refresh_token as string,
      grant_type: "refresh_token",
    }),
  });

  if (!refresh.ok) {
    throw new Error(`No se pudo refrescar token de Google (${refresh.status}).`);
  }

  const payload = (await refresh.json()) as {
    access_token: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  const newExpiresAt = payload.expires_in
    ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
    : oauth.expires_at;

  const save = await supabase
    .from("google_oauth_tokens")
    .update({
      access_token: payload.access_token,
      token_type: payload.token_type ?? oauth.token_type,
      scope: payload.scope ?? oauth.scope,
      expires_at: newExpiresAt,
    })
    .eq("user_id", userId);

  if (save.error) {
    throw new Error(save.error.message);
  }

  return payload.access_token;
}

function extractFolderId(raw: string) {
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{20,}$/.test(raw)) return raw;
  const match = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
