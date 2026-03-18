import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/config/app";
import { createClient } from "@/lib/supabase/server";

export async function ProtectedRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(ROUTES.auth);
  }

  return <>{children}</>;
}
