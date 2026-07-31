import type { NextConfig } from "next";

// Content Security Policy.
// unsafe-inline is required by Next.js for its own inline scripts/styles.
// We document this explicitly and scope it tightly.
const isDevelopment = process.env.NODE_ENV === "development";

const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  ...(isDevelopment ? ["'unsafe-eval'"] : []),
].join(" ");

const csp = [
  "default-src 'self'",
  // React and Turbopack require unsafe-eval for development diagnostics only.
  // Production keeps unsafe-eval disabled.
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "script-src-elem 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
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
    "/api/reports/**": ["./src/server/reports/assets/**"],
    "/api/internal/reports/**": ["./src/server/reports/assets/**"],
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
