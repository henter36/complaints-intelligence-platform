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
  // Without this, the standalone tracer copies whole top-level project
  // directories it has no business including — confirmed by inspecting a
  // real build: `.env` (build-time secrets), `backups/`, `storage/`
  // (real uploaded imports and generated reports), and a stray
  // `templates/` file all ended up inside `.next/standalone/`, none of
  // them referenced by any import/require path the app actually uses at
  // runtime. Shipping that artifact anywhere (a registry, a separate
  // web-only host per the deployment guide's "Minimal Web-Process
  // Footprint" section) would leak real operational data and secrets.
  // Runtime storage/backup paths are configured via IMPORT_STORAGE_PATH /
  // REPORT_STORAGE_PATH / BACKUP_PATH env vars (see src/lib/env.ts) — the
  // app never reads these directories by relative path, so excluding them
  // from the trace changes nothing about runtime behavior.
  outputFileTracingExcludes: {
    "*": [
      "./storage/**",
      "./backups/**",
      "./templates/**",
      "./.env*",
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
