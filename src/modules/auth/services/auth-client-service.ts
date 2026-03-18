"use client";

import { createClient } from "@/lib/supabase/client";
import type { LoginSchema } from "@/lib/validations/auth";

export async function signInWithPassword(payload: LoginSchema) {
  const supabase = createClient();
  return supabase.auth.signInWithPassword(payload);
}

export async function signOut() {
  const supabase = createClient();
  return supabase.auth.signOut();
}
