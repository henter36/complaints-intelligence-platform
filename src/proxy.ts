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

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function addSecurityHeaders(response: NextResponse, nonce: string): NextResponse {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("x-nonce", nonce);
  response.headers.set(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
  );
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const nonce = createNonce();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  if (!isPublicPath(pathname) && !hasSessionCookie) {
    if (pathname.startsWith("/api/")) {
      return addSecurityHeaders(NextResponse.json(AUTH_ERROR_RESPONSE, { status: 401 }), nonce);
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return addSecurityHeaders(NextResponse.redirect(loginUrl), nonce);
  }

  return addSecurityHeaders(NextResponse.next({ request: { headers: requestHeaders } }), nonce);
}

export const config = {
  matcher: ["/((?!.*[.].*).*)", "/api/:path*"],
};
