# Sistema Administrativo Desesplast

Reconstruccion modular con:

- Next.js + TypeScript + App Router
- Tailwind CSS + shadcn/ui
- Supabase (Auth, DB, Storage, Edge Functions)
- React Query + React Hook Form + Zod

## Scripts

```bash
npm install
npm run dev
npm run lint
npm run build
```

## Variables de entorno

Crear `.env.local` con:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SITE_DISABLED=false

SUPABASE_SERVICE_ROLE_KEY=
RESEND_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_SERVICE_ACCOUNT_JSON=
OPENAI_API_KEY=
```

## Estructura principal

- `src/app`: rutas (auth, dashboard protegido, portal publico)
- `src/components`: UI reutilizable y modulos visuales
- `src/lib`: config, supabase clients, validaciones, tipos, server actions
- `src/modules`: servicios por dominio
- `supabase/migrations`: schema y RLS
- `supabase/functions`: edge functions (procesamiento, email, drive, oauth)

## Nota de despliegue

Para entorno productivo se debe:

1. Ejecutar migraciones en Supabase.
2. Deployar edge functions.
3. Configurar secretos requeridos.
4. Ajustar politicas de storage segun estrategia final de acceso del portal.

## Google Drive OAuth (nuevo flujo)

1. Crear un proyecto nuevo en Google Cloud Console.
2. Habilitar Google Drive API.
3. Crear credenciales OAuth 2.0 (Web application).
4. Agregar como redirect URI:
   - `https://<tu-project-ref>.supabase.co/functions/v1/google-oauth-callback`
5. Cargar en Supabase secrets:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`

La app abre OAuth en popup y guarda tokens por usuario en `google_oauth_tokens`,
con refresh automatico cuando el access token esta por expirar.
