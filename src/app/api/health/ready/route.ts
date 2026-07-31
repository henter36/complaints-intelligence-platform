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

function safeCheckFailure(err: unknown, label: string): CheckResult {
  if (err instanceof Error) {
    const msg = err.message.replace(/\/[^\s]+(\/[^\s]+)*/g, "<path>");
    return { status: "error", detail: `${label}: ${msg}` };
  }
  return { status: "error", detail: label };
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    await db.$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch (err) {
    // Log server-side for diagnostics but never expose the raw error to callers
    logger.error("Readiness database check failed", { err });
    return { status: "error", detail: "database unreachable" };
  }
}

function checkStoragePath(storagePath: string): CheckResult {
  // Observational only — never create directories in a readiness probe.
  // Directory creation is a startup/deployment concern, not runtime health.
  try {
    accessSync(storagePath, fsConstants.R_OK | fsConstants.W_OK);
    return { status: "ok" };
  } catch (err) {
    return safeCheckFailure(err, `storage path inaccessible: ${basename(storagePath)}`);
  }
}

function checkAuth(): CheckResult {
  try {
    const secret = env.authSecret;
    if (!secret || secret.length < 8) return { status: "error", detail: "AUTH_SECRET not configured" };
    return { status: "ok" };
  } catch (err) {
    return safeCheckFailure(err, "auth config error");
  }
}

function checkAi(): CheckResult {
  if (!env.aiEnabled) return { status: "ok" };
  const key = env.openAiApiKey;
  if (!key) return { status: "error", detail: "AI_ENABLED but OPENAI_API_KEY missing" };
  return { status: "ok" };
}

export async function GET() {
  const [database, importStorage, reportStorage, auth, ai] = await Promise.all([
    checkDatabase(),
    Promise.resolve(checkStoragePath(env.importStoragePath)),
    Promise.resolve(checkStoragePath(env.reportStoragePath)),
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
