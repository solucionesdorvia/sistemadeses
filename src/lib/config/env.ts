import { z } from "zod";

const clientEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_DISABLED: z.string().optional(),
});

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  CONVERTAPI_SECRET: z.string().optional(),
  /** Si es "1"/"true"/"yes", fuerza apaisado + fit-to-width al generar PDF (comportamiento viejo). */
  CONVERT_PDF_FORCE_LANDSCAPE_FIT: z.string().optional(),
  /** Escala de impresion 10-400 para PDF (default 100). Subir (p. ej. 140) si el texto sale muy chico. */
  CONVERT_PDF_PRINT_SCALE: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

export function getClientEnv() {
  const raw = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_DISABLED: process.env.NEXT_PUBLIC_SITE_DISABLED,
  };

  const parsed = clientEnvSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  // Permite build local sin .env, pero falla naturalmente en runtime al intentar autenticar.
  return {
    NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
    NEXT_PUBLIC_SITE_DISABLED: raw.NEXT_PUBLIC_SITE_DISABLED,
  };
}

export function getServerEnv() {
  return serverEnvSchema.parse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    CONVERTAPI_SECRET: process.env.CONVERTAPI_SECRET,
    CONVERT_PDF_FORCE_LANDSCAPE_FIT: process.env.CONVERT_PDF_FORCE_LANDSCAPE_FIT,
    CONVERT_PDF_PRINT_SCALE: process.env.CONVERT_PDF_PRINT_SCALE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  });
}
