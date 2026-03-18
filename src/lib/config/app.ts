export const APP_NAME = "Sistema Desesplast";
export const APP_CREATOR = "Creado por Dorvia";

export const ROUTES = {
  auth: "/auth",
  dashboard: "/cuentas-corrientes",
  cuentasCorrientes: "/cuentas-corrientes",
  fichadas: "/fichadas",
  boletas: "/boletas",
  portal: "/portal",
  unavailable: "/service-unavailable",
} as const;

export const SITE_DISABLED =
  process.env.NEXT_PUBLIC_SITE_DISABLED?.toLowerCase() === "true";
export const ENABLE_GOOGLE_DRIVE =
  process.env.NEXT_PUBLIC_ENABLE_GOOGLE_DRIVE?.toLowerCase() === "true";

export const COMPANY_TYPES = ["americana", "days", "desesplast"] as const;

export const FILE_STATUSES = [
  "pending",
  "processing",
  "completed",
  "error",
] as const;
