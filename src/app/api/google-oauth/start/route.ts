import { NextResponse } from "next/server";

import { getServerEnv } from "@/lib/config/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const admin = createAdminClient();
    const {
      data: { user: initialUser },
    } = await supabase.auth.getUser();
    let user = initialUser;

    if (!user) {
      const authHeader = request.headers.get("authorization") ?? "";
      const jwt = authHeader.replace("Bearer ", "").trim();
      if (!jwt) {
        return NextResponse.json({ message: "Sesion invalida." }, { status: 401 });
      }
      const userResult = await admin.auth.getUser(jwt);
      if (userResult.error) {
        return NextResponse.json(
          { message: "Sesion expirada. Vuelve a iniciar sesion." },
          { status: 401 },
        );
      }
      user = userResult.data.user ?? null;
      if (!user) {
        return NextResponse.json({ message: "Sesion invalida." }, { status: 401 });
      }
    }

    const env = getServerEnv();
    if (!env.GOOGLE_CLIENT_ID) {
      return NextResponse.json(
        { message: "GOOGLE_CLIENT_ID no configurado." },
        { status: 500 },
      );
    }

    let body: { origin?: string } | null = null;
    try {
      body = (await request.json()) as { origin?: string };
    } catch {
      body = null;
    }
    const resolvedOrigin = body?.origin ?? new URL(request.url).origin;

    const state = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const stateInsert = await admin.from("google_oauth_states").insert({
      user_id: user.id,
      state,
      origin: resolvedOrigin,
      expires_at: expiresAt,
    });
    if (stateInsert.error) {
      return NextResponse.json({ message: stateInsert.error.message }, { status: 500 });
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/google-oauth-callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("scope", "https://www.googleapis.com/auth/drive");
    url.searchParams.set("state", state);

    return NextResponse.json({ authUrl: url.toString() });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "No se pudo iniciar OAuth." },
      { status: 500 },
    );
  }
}
