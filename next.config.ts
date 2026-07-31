import type { NextConfig } from "next";

// Content Security Policy is handled entirely by the edge middleware in
// src/proxy.ts, which attaches a per-request nonce. next.config.ts must NOT
// set a CSP header because the static header cannot carry the nonce — doing so
// would result in two conflicting CSP headers on every response.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  turbopack: {
    root: process.cwd(),
  },
  // pdfkit/fontkit read their own data files (standard font metrics, etc.)
  // relative to their installed location on disk; bundling them through
  // webpack/Turbopack breaks that resolution (ENOENT for Helvetica.afm), so
  // they must run as plain, un-bundled Node requires at runtime.
  serverExternalPackages: ["pdfkit", "fontkit"],
  outputFileTracingIncludes: {
    "/api/reports/**": [
      "./src/server/reports/assets/**",
    ],
    "/api/internal/reports/**": [
      "./src/server/reports/assets/**",
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
