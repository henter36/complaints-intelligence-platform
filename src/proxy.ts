import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE_NAME = "cip_session";
const AUTH_ERROR_RESPONSE = {
  error: {
    code: "UNAUTHORIZED",
    message: "يلزم تسجيل الدخول",
  },
};

const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/api/auth/login",
  "/_next",
  "/favicon",
  "/robots.txt",
  "/logo.svg",
];

const PUBLIC_API_PATHS = new Set(["/api", "/api/auth/login", "/api/auth/logout"]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_API_PATHS.has(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function addSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (!isPublicPath(pathname) && !hasSessionCookie) {
    if (pathname.startsWith("/api/")) {
      return addSecurityHeaders(NextResponse.json(AUTH_ERROR_RESPONSE, { status: 401 }));
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return addSecurityHeaders(NextResponse.redirect(loginUrl));
  }

  return addSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: ["/((?!.*[.].*).*)", "/api/:path*"],
};
