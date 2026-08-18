#!/usr/bin/env node
// Proves the standalone build artifact actually boots and serves a real
// request — not just that files exist on disk. This is what CI runs as a
// hard gate right after `npm run build` (see .github/workflows/ci.yml), and
// it is also reused, pointed at an isolated copy of .next/standalone (via
// --standalone-dir / STANDALONE_DIR), to prove the artifact is fully
// self-contained (no dependency on the repo's root node_modules, no
// prisma/tsx/typescript needed).
//
// Never uses a fixed sleep to wait for the server — polls with a bounded
// timeout — and always kills the child process, even on failure.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const flag = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(flag));
  return found ? found.slice(flag.length) : (process.env[name.toUpperCase().replace(/-/g, "_")] ?? fallback);
}

const STANDALONE_DIR = path.resolve(arg("standalone-dir", path.join(ROOT, ".next", "standalone")));
const SERVER_ENTRY = path.join(STANDALONE_DIR, "server.js");
const PORT = arg("port", "3127");
const HOSTNAME = "127.0.0.1";
const BASE_URL = `http://${HOSTNAME}:${PORT}`;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 300;

let tempDbDir = null;
let child = null;
const failures = [];

function log(msg) {
  console.log(`[standalone-smoke] ${msg}`);
}

function ok(label) {
  console.log(`  ✓ ${label}`);
}

function recordFailure(label, detail) {
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

/** A migrated, throwaway SQLite DB — never prisma/dev.db. */
function prepareTempDatabase() {
  tempDbDir = mkdtempSync(path.join(tmpdir(), "cip-standalone-smoke-"));
  const dbPath = path.join(tempDbDir, "smoke.db");
  const databaseUrl = `file:${dbPath}`;
  log(`Preparing temp database at ${dbPath}`);
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  return databaseUrl;
}

function findRealStaticAsset() {
  const staticDir = path.join(STANDALONE_DIR, ".next", "static");
  if (!existsSync(staticDir)) return null;
  const stack = [staticDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile() && stat.size > 0) {
        return `/_next/static/${path.relative(staticDir, full).split(path.sep).join("/")}`;
      }
    }
  }
  return null;
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server process exited early (code ${child.exitCode}) before becoming ready`);
    }
    try {
      const res = await fetch(`${BASE_URL}/robots.txt`);
      if (res.status > 0) return; // any HTTP response at all means the server is up
    } catch {
      // connection refused — not ready yet
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`server did not become ready within ${READY_TIMEOUT_MS}ms`);
}

async function checkStatus(pathname, expectedStatus, label) {
  try {
    const res = await fetch(`${BASE_URL}${pathname}`, { redirect: "manual" });
    if (res.status === expectedStatus) {
      ok(`${label} (${pathname}) -> ${res.status}`);
      return res;
    }
    recordFailure(`${label} (${pathname})`, `expected ${expectedStatus}, got ${res.status}`);
    return res;
  } catch (e) {
    recordFailure(`${label} (${pathname})`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

function checkSecurityHeaders(res, label) {
  if (!res) {
    recordFailure(`security headers (${label})`, "no response to check");
    return;
  }
  const required = ["x-frame-options", "x-content-type-options", "referrer-policy"];
  const missing = required.filter((h) => !res.headers.get(h));
  if (missing.length === 0) {
    ok(`security headers present (${label}): ${required.join(", ")}`);
  } else {
    recordFailure(`security headers (${label})`, `missing: ${missing.join(", ")}`);
  }
}

async function main() {
  if (!existsSync(SERVER_ENTRY)) {
    console.error(`\n✗ ${SERVER_ENTRY} not found. Run "npm run build" first.\n`);
    process.exit(1);
  }

  const databaseUrl = arg("database-url", null) ?? prepareTempDatabase();

  log(`Starting standalone server from ${STANDALONE_DIR} on ${BASE_URL}`);
  child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT,
      HOSTNAME,
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: arg("auth-secret", "a".repeat(64)),
      INTERNAL_SCHEDULER_SECRET: arg("scheduler-secret", "b".repeat(64)),
      COMPLAINANT_TOKEN_SECRET: arg("complainant-token-secret", "c".repeat(64)),
      NEXTAUTH_URL: BASE_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForReady();
    log("Server is accepting connections.");

    await checkStatus("/login", 200, "login page");
    await checkStatus("/logo.svg", 200, "public asset");
    const robotsRes = await checkStatus("/robots.txt", 200, "public asset");

    const staticAssetPath = findRealStaticAsset();
    if (staticAssetPath) {
      await checkStatus(staticAssetPath, 200, "Next static asset");
    } else {
      recordFailure("Next static asset", "no file found under .next/standalone/.next/static to test");
    }

    checkSecurityHeaders(robotsRes, "/robots.txt");
  } finally {
    log("Stopping server.");
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (tempDbDir) rmSync(tempDbDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n✗ Standalone runtime smoke failed (${failures.length} issue(s)):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\n✓ Standalone runtime smoke passed.");
}

main().catch((err) => {
  console.error("Standalone runtime smoke error:", err instanceof Error ? err.message : err);
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (tempDbDir) rmSync(tempDbDir, { recursive: true, force: true });
  process.exit(1);
});
