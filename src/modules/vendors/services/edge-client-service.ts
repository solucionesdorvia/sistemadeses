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
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      Authorization: `Bearer ${session.access_token}`,
      "x-user-jwt": session.access_token,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
  };

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
