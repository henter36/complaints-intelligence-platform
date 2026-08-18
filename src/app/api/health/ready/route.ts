import { NextResponse } from "next/server";
import { accessSync, constants as fsConstants } from "node:fs";
import { basename } from "node:path";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/server/logger";

interface CheckResult {
  status: "ok" | "error";
  detail?: string;
}

/**
 * This route is on the unauthenticated allowlist (see src/proxy.ts's
 * PUBLIC_API_PATHS) — a monitoring tool with no admin session hits it
 * directly, so the response `detail` string is the ONLY thing this
 * function is allowed to control. It is a fixed, static label, never a
 * raw caught error's `.message` — an earlier version tried to redact
 * absolute paths out of `err.message` with a regex, which is fragile by
 * construction (e.g. a storage path containing a space defeats a
 * whitespace-delimited pattern, leaking path fragments). The actual error
 * always still goes to the server-side logger for real diagnostics —
 * operators read logs, monitoring tools read this JSON.
 */
function checkFailure(label: string): CheckResult {
  return { status: "error", detail: label };
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    await db.$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch (err) {
    logger.error("Readiness database check failed", { err });
    return checkFailure("database unreachable");
  }
}

function checkStoragePath(label: string, storagePath: string): CheckResult {
  // Observational only — never create directories in a readiness probe.
  // Directory creation is a startup/deployment concern, not runtime health.
  try {
    accessSync(storagePath, fsConstants.R_OK | fsConstants.W_OK);
    return { status: "ok" };
  } catch (err) {
    logger.error(`Readiness ${label} storage check failed`, { err, storagePath });
    return checkFailure(`storage path inaccessible: ${basename(storagePath)}`);
  }
}

function checkAuth(): CheckResult {
  const secret = env.authSecret;
  if (!secret || secret.length < 8) return checkFailure("AUTH_SECRET not configured");
  return { status: "ok" };
}

/**
 * Deliberately config-only — never a network call to the AI provider.
 * Production startup already refuses to boot with AI_ENABLED=true and a
 * missing/placeholder OPENAI_API_KEY (see src/lib/env.ts), so this branch
 * is effectively unreachable in production; it only matters in dev/test
 * where that startup guard doesn't run.
 */
function checkAi(): CheckResult {
  if (!env.aiEnabled) return { status: "ok" };
  if (!env.openAiApiKey) return checkFailure("AI_ENABLED but OPENAI_API_KEY missing");
  return { status: "ok" };
}

export async function GET() {
  const [database, importStorage, reportStorage, auth, ai] = await Promise.all([
    checkDatabase(),
    Promise.resolve(checkStoragePath("importStorage", env.importStoragePath)),
    Promise.resolve(checkStoragePath("reportStorage", env.reportStoragePath)),
    Promise.resolve(checkAuth()),
    Promise.resolve(checkAi()),
  ]);

  const checks = {
    database,
    importStorage,
    reportStorage,
    auth,
    ai: env.aiEnabled ? ai : { status: "ok" as const },
  };

  const allOk = Object.values(checks).every(c => c.status === "ok");
  const status = allOk ? "ready" : "degraded";

  return NextResponse.json(
    {
      status,
      checks: Object.fromEntries(
        Object.entries(checks).map(([k, v]) => [
          k,
          v.status === "ok" ? "ok" : `error: ${v.detail ?? "unknown"}`,
        ])
      ),
    },
    { status: allOk ? 200 : 503 }
  );
}
