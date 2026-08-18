#!/usr/bin/env node
// Finishes what `next build` (output: "standalone") leaves incomplete.
//
// Next's standalone output traces the JS/TS dependency graph into
// `.next/standalone/`, but by design it does NOT copy `public/` or
// `.next/static/` — those aren't `require()`d by any server code, so the
// tracer never sees them. Without this script, `node .next/standalone/server.js`
// boots but 404s on every static asset (`/logo.svg`, `/_next/static/...`).
//
// Plain node:fs only — no shell `cp`, no new dependency — so this runs
// identically on macOS/Linux/CI and never needs a shell interpreter present.

import { existsSync, cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STANDALONE_DIR = path.join(ROOT, ".next", "standalone");
const SERVER_ENTRY = path.join(STANDALONE_DIR, "server.js");

function fail(message) {
  console.error(`\n✗ prepare-standalone-runtime: ${message}\n`);
  process.exit(1);
}

function removeIfExists(target) {
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

function copyDir(from, to, label) {
  if (!existsSync(from)) {
    console.log(`  (skipped) ${label} — nothing at ${path.relative(ROOT, from)}`);
    return;
  }
  removeIfExists(to);
  cpSync(from, to, { recursive: true });
  console.log(`  copied ${label} -> ${path.relative(ROOT, to)}`);
}

function main() {
  if (!existsSync(SERVER_ENTRY)) {
    fail(
      `${path.relative(ROOT, SERVER_ENTRY)} not found. Run "next build" first ` +
        `(this script only prepares an EXISTING standalone build — it does not run one). ` +
        `Check next.config.ts has output: "standalone".`
    );
  }

  console.log("Preparing standalone runtime artifact...");

  copyDir(path.join(ROOT, "public"), path.join(STANDALONE_DIR, "public"), "public/");
  copyDir(
    path.join(ROOT, ".next", "static"),
    path.join(STANDALONE_DIR, ".next", "static"),
    ".next/static/"
  );

  // Next's build ALWAYS writes a snapshot of whatever .env*/*.env files
  // existed on the build host at build time into .next/standalone/.env
  // (a core, non-configurable step — see writeStandaloneDirectory in
  // next/dist/build/index.js; outputFileTracingExcludes does not affect it).
  // The generated server.js also does `process.chdir(__dirname)` before
  // starting, so it would load THIS baked snapshot, not whatever .env
  // exists wherever you happen to invoke `node server.js` from. Shipping a
  // secrets snapshot inside a build artifact that might be copied to
  // another host, a registry, or backed up is exactly what "Minimal
  // Web-Process Footprint" in the deployment guide says never to do —
  // remove it so the runtime host is forced to supply real env vars itself
  // (systemd EnvironmentFile=, PM2 env config, or an explicit VAR=... prefix),
  // never a frozen build-time copy that silently goes stale after the next
  // secret rotation.
  removeIfExists(path.join(STANDALONE_DIR, ".env"));
  removeIfExists(path.join(STANDALONE_DIR, ".env.production"));
  removeIfExists(path.join(STANDALONE_DIR, ".env.local"));
  removeIfExists(path.join(STANDALONE_DIR, ".env.production.local"));

  // Defense in depth: next.config.ts's outputFileTracingExcludes already
  // keeps these out (confirmed empirically — an earlier build leaked real
  // uploaded imports, backup archives, and a stray template file into the
  // artifact this way), but a config regression or a future Next.js
  // tracing behavior change should never silently resurrect them.
  for (const dir of ["storage", "backups", "templates"]) {
    const target = path.join(STANDALONE_DIR, dir);
    if (existsSync(target)) {
      fail(
        `${path.relative(ROOT, target)} exists inside the standalone artifact — ` +
          `this is real operational data/output, not an app dependency, and must ` +
          `never ship in a build artifact. Check next.config.ts's ` +
          `outputFileTracingExcludes hasn't regressed.`
      );
    }
  }

  console.log("Standalone runtime artifact ready.");
}

main();
