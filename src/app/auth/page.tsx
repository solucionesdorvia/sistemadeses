import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/config/app";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "@/modules/auth/components/login-form";

export default async function AuthPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect(ROUTES.dashboard);
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <LoginForm />
    </div>
  );
}
