"use client";

import { createClient } from "@/lib/supabase/client";

type EdgeInvokeOptions = {
  functionName: string;
  body: Record<string, unknown>;
};

export async function invokeEdgeFunction<T = unknown>({
  functionName,
  body,
}: EdgeInvokeOptions): Promise<T> {
  const supabase = createClient();
  let {
    data: { session },
  } = await supabase.auth.getSession();

  // Fuerza token fresco para edge functions y evita JWT stale en arranque.
  const proactiveRefresh = await supabase.auth.refreshSession();
  if (proactiveRefresh.data.session?.access_token) {
    session = proactiveRefresh.data.session;
  }

  if (!session?.access_token) {
    throw new Error("Sesion invalida o expirada. Inicia sesion nuevamente.");
  }

  const userCheck = await supabase.auth.getUser();
  if (userCheck.error || !userCheck.data.user) {
    const refreshed = await supabase.auth.refreshSession();
    session = refreshed.data.session;
  }

  if (!session?.access_token) {
    throw new Error("Sesion expirada. Vuelve a iniciar sesion.");
  }

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${functionName}`;
  const invokeWithToken = async (accessToken: string) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
        Authorization: `Bearer ${accessToken}`,
        "x-user-jwt": accessToken,
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    return { response, payload };
  };

  let { response, payload } = await invokeWithToken(session.access_token);

  const authFailed =
    response.status === 401 ||
    (payload.message ?? "").toLowerCase().includes("invalid jwt") ||
    (payload.message ?? "").toLowerCase().includes("missing authorization header");

  if (!response.ok && authFailed) {
    const refreshed = await supabase.auth.refreshSession();
    const refreshedToken = refreshed.data.session?.access_token;
    if (refreshedToken) {
      const retry = await invokeWithToken(refreshedToken);
      response = retry.response;
      payload = retry.payload;
    }
  }

  if (!response.ok) {
    if ((payload.message ?? "").toLowerCase().includes("invalid jwt")) {
      throw new Error("Sesion expirada. Cierra sesion y vuelve a ingresar.");
    }
    throw new Error(
      payload.message ?? `Edge function ${functionName} fallo (${response.status}).`,
    );
  }

  return payload as T;
}
