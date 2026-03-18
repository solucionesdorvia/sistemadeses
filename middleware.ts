import { type NextRequest, NextResponse } from "next/server";

import { ROUTES, SITE_DISABLED } from "@/lib/config/app";
import { updateSession } from "@/lib/supabase/middleware";

const PUBLIC_ROUTES = [ROUTES.auth];
const PUBLIC_PREFIXES = ["/portal", "/api/portal", "/service-unavailable"];

function isPublicPath(pathname: string) {
  return (
    PUBLIC_ROUTES.includes(pathname as (typeof PUBLIC_ROUTES)[number]) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith("/_next") ||
    pathname.includes(".") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  if (SITE_DISABLED && pathname !== ROUTES.unavailable) {
    return NextResponse.redirect(new URL(ROUTES.unavailable, request.url));
  }

  if (!SITE_DISABLED && pathname === ROUTES.unavailable) {
    return NextResponse.redirect(new URL(ROUTES.dashboard, request.url));
  }

  const response = await updateSession(request);
  if (isPublicPath(pathname)) {
    return response;
  }

  // Validacion rapida de cookie de sesion supabase.
  const hasAuthCookie = request.cookies
    .getAll()
    .some((cookie) => cookie.name.includes("sb-") && cookie.name.endsWith("-auth-token"));

  if (!hasAuthCookie) {
    return NextResponse.redirect(new URL(ROUTES.auth, request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
