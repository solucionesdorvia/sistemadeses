import { createClient } from "@supabase/supabase-js";

import { getClientEnv, getServerEnv } from "@/lib/config/env";

export function createAdminClient() {
  const clientEnv = getClientEnv();
  const serverEnv = getServerEnv();
  if (!serverEnv.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY no configurado. El portal publico no puede firmar descargas.",
    );
  }

  return createClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
