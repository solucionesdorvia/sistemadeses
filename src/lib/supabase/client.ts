"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getClientEnv } from "@/lib/config/env";

export function createClient() {
  const env = getClientEnv();
  return createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
