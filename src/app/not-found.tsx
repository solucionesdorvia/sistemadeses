import Link from "next/link";

import { ROUTES } from "@/lib/config/app";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-4xl font-semibold">404</h1>
      <p className="text-muted-foreground">
        La pagina que intentas abrir no existe.
      </p>
      <Link
        href={ROUTES.cuentasCorrientes}
        className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Volver al sistema
      </Link>
    </div>
  );
}
