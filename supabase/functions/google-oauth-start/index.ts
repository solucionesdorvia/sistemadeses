import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";
import { getRequestUserId } from "../_shared/auth.ts";

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
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");

    if (!clientId || !supabaseUrl) {
      return new Response(JSON.stringify({ message: "Google OAuth no configurado." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = (await request.json().catch(() => ({}))) as { origin?: string };
    const state = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const stateInsert = await supabase.from("google_oauth_states").insert({
      user_id: userId,
      state,
      origin: body.origin ?? null,
      expires_at: expiresAt,
    });

    if (stateInsert.error) {
      throw new Error(stateInsert.error.message);
    }

    const redirectUri = `${supabaseUrl}/functions/v1/google-oauth-callback`;
    const scope = "https://www.googleapis.com/auth/drive";
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);

    return new Response(JSON.stringify({ authUrl: url.toString() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        message: error instanceof Error ? error.message : "No se pudo iniciar OAuth.",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  
});
