"use client";

import { createClient } from "@/lib/supabase/client";

type EdgeInvokeOptions = {
  functionName: string;
  body: Record<string, unknown>;
};

async function getFreshAccessToken(): Promise<string> {
  const supabase = createClient();

  const { data: refreshData } = await supabase.auth.refreshSession();
  if (refreshData.session?.access_token) {
    return refreshData.session.access_token;
  }

  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session?.access_token) {
    return sessionData.session.access_token;
  }

  throw new Error("Sesion invalida o expirada. Inicia sesion nuevamente.");
}

export async function invokeEdgeFunction<T = unknown>({
  functionName,
  body,
}: EdgeInvokeOptions): Promise<T> {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${functionName}`;

  const accessToken = await getFreshAccessToken();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "x-user-jwt": accessToken,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
  };

  if (!response.ok) {
    throw new Error(
      payload.message ?? `Edge function ${functionName} fallo (${response.status}).`,
    );
  }

  return payload as T;
}
