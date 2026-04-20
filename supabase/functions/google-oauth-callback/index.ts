import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const stateToken = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      throw new Error(`Google OAuth rechazo la autorizacion: ${oauthError}`);
    }
    if (!code) throw new Error("No se recibio codigo OAuth.");
    if (!stateToken) throw new Error("State OAuth faltante.");

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!clientId || !clientSecret || !supabaseUrl) {
      throw new Error("Configuracion OAuth incompleta.");
    }

    const tokenResult = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${supabaseUrl}/functions/v1/google-oauth-callback`,
        grant_type: "authorization_code",
      }),
    });

    const tokenRaw = await tokenResult.text();
    let tokenPayload: {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    } = {};
    try {
      tokenPayload = JSON.parse(tokenRaw) as typeof tokenPayload;
    } catch {
      /* ignore */
    }

    if (!tokenResult.ok) {
      const code = tokenPayload.error ?? "error_desconocido";
      const desc = tokenPayload.error_description
        ? ` ${tokenPayload.error_description}`
        : tokenRaw && !tokenPayload.error
          ? ` ${tokenRaw.slice(0, 280)}`
          : "";
      throw new Error(`No se pudo obtener token de Google (${tokenResult.status}): ${code}.${desc}`);
    }

    if (!tokenPayload.access_token) {
      throw new Error("Google no devolvio access_token.");
    }

    const stateRow = await supabase
      .from("google_oauth_states")
      .select("id,user_id,origin,expires_at")
      .eq("state", stateToken)
      .single();

    if (stateRow.error || !stateRow.data) {
      throw new Error("State OAuth invalido o expirado.");
    }

    if (new Date(stateRow.data.expires_at).getTime() < Date.now()) {
      throw new Error("State OAuth expirado.");
    }

    const expiresAt = tokenPayload.expires_in
      ? new Date(Date.now() + tokenPayload.expires_in * 1000).toISOString()
      : null;

    const upsert = await supabase.from("google_oauth_tokens").upsert(
      {
        user_id: stateRow.data.user_id,
        access_token: tokenPayload.access_token,
        refresh_token: tokenPayload.refresh_token ?? null,
        token_type: tokenPayload.token_type ?? null,
        scope: tokenPayload.scope ?? null,
        expires_at: expiresAt,
      },
      { onConflict: "user_id" },
    );

    if (upsert.error) throw new Error(upsert.error.message);

    await supabase.from("google_oauth_states").delete().eq("id", stateRow.data.id);

    const targetOrigin = stateRow.data.origin ?? "*";

    return new Response(
      `<script>
        window.opener?.postMessage({ type: "google-oauth-success" }, "${targetOrigin}");
        window.close();
      </script>`,
      { headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } },
    );
  } catch {
    return new Response(
      `<script>
        window.opener?.postMessage({ type: "google-oauth-error" }, "*");
        window.close();
      </script>`,
      { status: 500, headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } },
    );
  }
});
