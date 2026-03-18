import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/config/app";

export default function ProtectedRootPage() {
  redirect(ROUTES.cuentasCorrientes);
}
