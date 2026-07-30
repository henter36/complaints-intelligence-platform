import type { NextConfig } from "next";

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
};

export default nextConfig;
