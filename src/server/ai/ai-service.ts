// Core AI analysis orchestration. Handles governance, rate limiting,
// data sanitization, provider calls, result validation, and audit logging.

import type { AiAnalysisType } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/server/logger";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import { sanitizeComplaintsForAi, buildAggregateStats } from "./ai-data-sanitization-service";
import { callOpenAI, AiProviderError } from "./openai-provider";
import { ANALYSIS_SCHEMAS } from "./ai-contracts";
import * as executiveSummaryPrompt from "./prompts/executive-summary";
import * as recurringTopicsPrompt from "./prompts/recurring-topics";
import * as possibleRootCausesPrompt from "./prompts/possible-root-causes";
import * as anomalyAnalysisPrompt from "./prompts/anomaly-analysis";
import * as improvementOpportunitiesPrompt from "./prompts/improvement-opportunities";

// Stale run window: runs older than this are excluded from the active-run check.
// A run stuck in PENDING/RUNNING past this window is considered dead.
const ACTIVE_RUN_STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes

// Pre-provider failure codes that don't consume API budget. Runs that fail with
// these codes are excluded from the daily run limit count.
const PRE_PROVIDER_ERROR_CODES = ["AI_KEY_MISSING", "STALE_RUN", "INVALID_REQUEST", "AI_NO_DATA"];

export interface AnalysisFilters {
  dateFrom?: string;
  dateTo?: string;
  department?: string;
  region?: string;
  classification?: string;
  status?: string;
}

export class AiDisabledError extends Error {
  constructor() { super("AI_DISABLED"); this.name = "AiDisabledError"; }
}
export class AiRateLimitError extends Error {
  constructor(public reason: string) { super(reason); this.name = "AiRateLimitError"; }
}
export class AiRunConflictError extends Error {
  constructor() { super("AI_RUN_CONFLICT"); this.name = "AiRunConflictError"; }
}
export class AiValidationError extends Error {
  constructor(public detail: string) { super(detail); this.name = "AiValidationError"; }
}
export class AiNoDataError extends Error {
  constructor() { super("AI_NO_DATA"); this.name = "AiNoDataError"; }
}

// ─── Filter normalization ────────────────────────────────────────────────────

function normalizeAnalysisFilters(raw: AnalysisFilters): AnalysisFilters {
  const f: AnalysisFilters = {};
  if (raw.dateFrom?.trim()) f.dateFrom = raw.dateFrom.trim();
  if (raw.dateTo?.trim()) f.dateTo = raw.dateTo.trim();
  if (raw.department?.trim()) f.department = raw.department.trim();
  if (raw.region?.trim()) f.region = raw.region.trim();
  if (raw.classification?.trim()) f.classification = raw.classification.trim();
  if (raw.status?.trim()) f.status = raw.status.trim();
  return f;
}

// Stable locale-aware comparator for deterministic key ordering.
// "en" locale with base sensitivity sorts ASCII-only filter keys identically
// across all Node.js environments regardless of ICU data variant.
const SORT_LOCALE = "en";

function compareJsonKeys(a: string, b: string): number {
  return a.localeCompare(b, SORT_LOCALE, { sensitivity: "base", numeric: true });
}

// Deterministic JSON snapshot: sort keys so {a:1,b:2} === {b:2,a:1}.
// Used for both duplicate-detection query and the stored filtersSnapshot.
function normalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(obj).sort(compareJsonKeys).map(k => [k, normalizeJsonValue(obj[k])])
  );
}

function toFiltersSnapshot(filters: AnalysisFilters): Record<string, unknown> {
  return normalizeJsonValue(filters) as Record<string, unknown>;
}

// ─── Where clause builder ────────────────────────────────────────────────────

function buildComplaintWhere(filters: AnalysisFilters): Record<string, unknown> {
  const where: Record<string, unknown> = { isDeleted: false };
  if (filters.dateFrom || filters.dateTo) {
    const dateFilter: Record<string, Date> = {};
    if (filters.dateFrom) dateFilter.gte = new Date(filters.dateFrom);
    if (filters.dateTo) dateFilter.lte = new Date(filters.dateTo);
    where.complaintDate = dateFilter;
  }
  if (filters.department) where.department = filters.department;
  if (filters.region) where.region = filters.region;
  if (filters.status) where.status = filters.status;
  if (filters.classification) {
    // classification filter matches the nameAr field in the Classification relation
    where.classification = { is: { nameAr: filters.classification } };
  }
  return where;
}

// ─── Prompt helpers ──────────────────────────────────────────────────────────

function getPromptVersion(type: AiAnalysisType): string {
  const versions: Record<AiAnalysisType, string> = {
    EXECUTIVE_SUMMARY: executiveSummaryPrompt.PROMPT_VERSION,
    RECURRING_TOPICS: recurringTopicsPrompt.PROMPT_VERSION,
    POSSIBLE_ROOT_CAUSES: possibleRootCausesPrompt.PROMPT_VERSION,
    ANOMALY_ANALYSIS: anomalyAnalysisPrompt.PROMPT_VERSION,
    IMPROVEMENT_OPPORTUNITIES: improvementOpportunitiesPrompt.PROMPT_VERSION,
  };
  return versions[type];
}

function getSystemMessage(type: AiAnalysisType): string {
  const messages: Record<AiAnalysisType, string> = {
    EXECUTIVE_SUMMARY: executiveSummaryPrompt.SYSTEM_MESSAGE,
    RECURRING_TOPICS: recurringTopicsPrompt.SYSTEM_MESSAGE,
    POSSIBLE_ROOT_CAUSES: possibleRootCausesPrompt.SYSTEM_MESSAGE,
    ANOMALY_ANALYSIS: anomalyAnalysisPrompt.SYSTEM_MESSAGE,
    IMPROVEMENT_OPPORTUNITIES: improvementOpportunitiesPrompt.SYSTEM_MESSAGE,
  };
  return messages[type];
}

function buildUserMessage(type: AiAnalysisType, statsJson: string, sampleJson: string, filters: AnalysisFilters): string {
  const period = [filters.dateFrom, filters.dateTo].filter(Boolean).join(" → ") || "الفترة الكاملة";
  switch (type) {
    case "EXECUTIVE_SUMMARY":
      return executiveSummaryPrompt.buildPrompt(statsJson, sampleJson, period);
    case "RECURRING_TOPICS":
      return recurringTopicsPrompt.buildPrompt(statsJson, sampleJson);
    case "POSSIBLE_ROOT_CAUSES":
      return possibleRootCausesPrompt.buildPrompt(statsJson, sampleJson);
    case "ANOMALY_ANALYSIS":
      return anomalyAnalysisPrompt.buildPrompt(statsJson, sampleJson);
    case "IMPROVEMENT_OPPORTUNITIES":
      return improvementOpportunitiesPrompt.buildPrompt(statsJson, sampleJson);
    default:
      throw new Error(`Unknown analysis type: ${String(type)}`);
  }
}

// ─── Rate limit checks ───────────────────────────────────────────────────────

async function sweepStaleRuns(): Promise<void> {
  const staleThreshold = new Date(Date.now() - ACTIVE_RUN_STALE_AFTER_MS);
  const staleCount = await db.aiAnalysisRun.count({
    where: {
      status: { in: ["PENDING", "RUNNING"] },
      createdAt: { lt: staleThreshold },
    },
  });
  if (staleCount > 0) {
    await db.aiAnalysisRun.updateMany({
      where: {
        status: { in: ["PENDING", "RUNNING"] },
        createdAt: { lt: staleThreshold },
      },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        errorCode: "STALE_RUN",
        errorMessage: "Run exceeded stale timeout and was automatically failed.",
      },
    });
    logger.warn("Swept stale AI runs", { count: staleCount });
  }
}

async function checkRateLimits(type: AiAnalysisType, filtersSnapshot: Record<string, unknown>): Promise<void> {
  // Sweep stale runs first so they don't block the system indefinitely
  await sweepStaleRuns();

  // Check concurrent run (only runs within the stale window count as "active")
  const staleThreshold = new Date(Date.now() - ACTIVE_RUN_STALE_AFTER_MS);
  const running = await db.aiAnalysisRun.count({
    where: {
      status: { in: ["PENDING", "RUNNING"] },
      createdAt: { gte: staleThreshold },
    },
  });
  if (running > 0) {
    throw new AiRunConflictError();
  }

  // Check daily limit. Only pre-provider failures (which never spent API budget)
  // are excluded from the count; any run that reached the provider still counts.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = await db.aiAnalysisRun.count({
    where: {
      createdAt: { gte: today },
      NOT: {
        AND: [
          { status: "FAILED" },
          { errorCode: { in: PRE_PROVIDER_ERROR_CODES } },
        ],
      },
    },
  });
  if (todayCount >= env.aiDailyRunLimit) {
    throw new AiRateLimitError(`Daily AI run limit (${env.aiDailyRunLimit}) reached.`);
  }

  // Check duplicate in last 5 minutes using the same deterministic snapshot
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const duplicate = await db.aiAnalysisRun.findFirst({
    where: {
      analysisType: type,
      createdAt: { gte: fiveMinAgo },
      status: { in: ["COMPLETED", "RUNNING", "PENDING"] },
      filtersSnapshot: { equals: filtersSnapshot as object },
    },
  });
  if (duplicate) {
    throw new AiRateLimitError("Duplicate analysis with same filters within 5 minutes.");
  }
}

// ─── Data loading ────────────────────────────────────────────────────────────

async function loadAnalysisPopulation(where: Record<string, unknown>) {
  // Get the true total count without any cap
  const totalMatching = await db.complaint.count({ where });

  // Load only up to the AI input cap for the actual prompt
  const complaints = await db.complaint.findMany({
    where,
    select: {
      id: true,
      subject: true,
      description: true,
      department: true,
      region: true,
      facility: true,
      status: true,
      channel: true,
      complaintDate: true,
      dueDate: true,
      classification: { select: { nameAr: true } },
    },
    take: env.aiMaxInputComplaints,
    orderBy: { complaintDate: "desc" },
  });

  return { complaints, totalMatching };
}

// ─── Run persistence helpers ─────────────────────────────────────────────────

async function createAnalysisRun(
  type: AiAnalysisType,
  filtersSnapshot: Record<string, unknown>,
  inputSummary: object,
  promptVersion: string
) {
  const expiresAt = new Date(Date.now() + env.aiRetentionDays * 24 * 60 * 60 * 1000);
  return db.aiAnalysisRun.create({
    data: {
      analysisType: type,
      status: "PENDING",
      filtersSnapshot: filtersSnapshot as object,
      inputSummary,
      provider: env.aiProvider,
      model: env.aiModel,
      promptVersion,
      expiresAt,
    },
  });
}

async function persistAnalysisSuccess(
  runId: string,
  providerModel: string,
  validatedData: object,
  resultText: string
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.aiAnalysisRun.update({
      where: { id: runId },
      data: { status: "COMPLETED", completedAt: new Date(), model: providerModel },
    });
    await tx.aiAnalysisResult.create({
      data: {
        analysisRunId: runId,
        resultJson: validatedData,
        resultText: resultText.slice(0, 10000),
      },
    });
  });
}

async function persistAnalysisFailure(
  runId: string,
  errorCode: string,
  errorMessage: string
): Promise<void> {
  try {
    await db.aiAnalysisRun.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
      },
    });
  } catch (stateError) {
    logger.error("Failed to persist AI run failure", {
      runId,
      originalErrorCode: errorCode,
      err: stateError,
    });
    // Do not throw — the original error will be re-thrown by the caller
  }
}

// ─── Provider execution ──────────────────────────────────────────────────────

async function executeAnalysisProvider(
  type: AiAnalysisType,
  statsJson: string,
  sampleJson: string,
  filters: AnalysisFilters
): Promise<{ text: string; model: string }> {
  const userMessage = buildUserMessage(type, statsJson, sampleJson, filters);
  const systemMessage = getSystemMessage(type);
  const result = await callOpenAI({
    model: env.aiModel,
    prompt: userMessage,
    systemMessage,
    timeoutMs: env.aiRequestTimeoutSeconds * 1000,
    maxOutputTokens: 4096,
  });
  return { text: result.text, model: result.model };
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function runAiAnalysis(
  type: AiAnalysisType,
  rawFilters: AnalysisFilters
): Promise<string> {
  if (!env.aiEnabled) {
    throw new AiDisabledError();
  }

  const filters = normalizeAnalysisFilters(rawFilters);
  const filtersSnapshot = toFiltersSnapshot(filters);

  await checkRateLimits(type, filtersSnapshot);

  const where = buildComplaintWhere(filters);
  const { complaints, totalMatching } = await loadAnalysisPopulation(where);

  const mapped = complaints.map(c => ({
    id: c.id,
    subject: c.subject,
    description: c.description,
    department: c.department,
    region: c.region,
    facility: c.facility,
    status: c.status,
    channel: c.channel,
    complaintDate: c.complaintDate,
    dueDate: c.dueDate,
    classification: c.classification?.nameAr,
  }));

  if (totalMatching === 0) {
    throw new AiNoDataError();
  }

  const { records, truncated } = sanitizeComplaintsForAi(
    mapped,
    env.aiMaxInputComplaints,
    env.aiMaxInputChars
  );

  // Build stats from all loaded complaints (not just the sanitized sample)
  // so totals are accurate even when the sample is capped by char budget.
  const stats = buildAggregateStats(mapped);
  // stats.totalComplaints reflects the full matching population (may exceed the
  // loaded cap), while the sample sent to the model is only `records`.
  stats.totalComplaints = totalMatching;

  const statsJson = JSON.stringify(stats, null, 2);
  const sampleJson = JSON.stringify(records.slice(0, 50), null, 2);
  const inputSummary = {
    // totalMatching is the full population count; sentToAi is the analyzed sample.
    totalMatching,
    sentToAi: records.length,
    truncated: truncated || totalMatching > env.aiMaxInputComplaints,
    note: totalMatching > records.length
      ? "stats.totalComplaints reflects the full population; the sample sent to the model is a subset"
      : "stats.totalComplaints and the sample sent to the model cover the same population",
  };

  const promptVersion = getPromptVersion(type);
  const run = await createAnalysisRun(type, filtersSnapshot, inputSummary, promptVersion);

  await writeAuditLog(db, {
    action: "AI_ANALYSIS_REQUESTED",
    entityType: "AiAnalysisRun",
    entityId: run.id,
    actor: AUDIT_ACTOR_SINGLE_ADMIN,
    metadata: { analysisType: type, inputComplaintCount: totalMatching, promptVersion },
  });

  await db.aiAnalysisRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
  await writeAuditLog(db, {
    action: "AI_ANALYSIS_STARTED",
    entityType: "AiAnalysisRun",
    entityId: run.id,
    actor: AUDIT_ACTOR_SINGLE_ADMIN,
    metadata: { analysisType: type },
  });

  const startMs = Date.now();

  try {
    const { text, model: providerModel } = await executeAnalysisProvider(type, statsJson, sampleJson, filters);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AiValidationError("AI returned invalid JSON.");
    }

    const schema = ANALYSIS_SCHEMAS[type];
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      logger.warn("AI output validation failed", { type, issues: validated.error.issues.slice(0, 3) });
      throw new AiValidationError(`AI output does not match expected schema: ${validated.error.issues[0]?.message}`);
    }

    await persistAnalysisSuccess(run.id, providerModel, validated.data as object, text);

    const durationMs = Date.now() - startMs;
    await writeAuditLog(db, {
      action: "AI_ANALYSIS_COMPLETED",
      entityType: "AiAnalysisRun",
      entityId: run.id,
      actor: AUDIT_ACTOR_SINGLE_ADMIN,
      metadata: { analysisType: type, provider: env.aiProvider, model: providerModel, promptVersion, inputComplaintCount: totalMatching, durationMs },
    });

    return run.id;
  } catch (err) {
    const durationMs = Date.now() - startMs;
    let errorCode = "UNKNOWN";
    let errorMessage = "Unknown error";

    if (err instanceof AiProviderError) {
      errorCode = err.code;
      errorMessage = err.message;
    } else if (err instanceof AiValidationError) {
      errorCode = "VALIDATION_ERROR";
      errorMessage = err.detail;
    } else if (err instanceof AiNoDataError) {
      errorCode = "AI_NO_DATA";
      errorMessage = "No complaints matched the filters.";
    } else if (err instanceof Error) {
      errorMessage = err.message;
    }

    // persistAnalysisFailure has its own error guard and won't throw
    await persistAnalysisFailure(run.id, errorCode, errorMessage);

    await writeAuditLog(db, {
      action: "AI_ANALYSIS_FAILED",
      entityType: "AiAnalysisRun",
      entityId: run.id,
      actor: AUDIT_ACTOR_SINGLE_ADMIN,
      metadata: { analysisType: type, errorCode, durationMs },
    });

    throw err;
  }
}
