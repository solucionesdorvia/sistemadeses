import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export async function getRequestUserId(request: Request) {
  const userJwtHeader = request.headers.get("x-user-jwt") ?? "";
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = userJwtHeader.trim() || authHeader.replace("Bearer ", "").trim();

  if (!token) {
    throw new Error("Falta Authorization Bearer token.");
  }

  const userResult = await supabase.auth.getUser(token);
  if (userResult.error || !userResult.data.user) {
    throw new Error("No se pudo resolver usuario autenticado.");
  }

  return userResult.data.user.id;
}
