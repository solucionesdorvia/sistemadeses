import { redirect } from "next/navigation";

import { AppLayout } from "@/components/layout/app-layout";
import { ROUTES } from "@/lib/config/app";
import { createClient } from "@/lib/supabase/server";

export default async function ProtectedLayout({
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

  return <AppLayout userEmail={user.email ?? "usuario@desconocido"}>{children}</AppLayout>;
}
