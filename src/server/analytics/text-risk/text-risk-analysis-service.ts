import {
  ComplaintPriority,
  ImportBatchStatus,
  TextRiskCertainty,
  TextRiskReviewStatus,
  TextRiskScanStatus,
  TextRiskSignalType,
  type Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SYSTEM } from "@/server/audit/audit-log-service";
import { normalizeFacilityName } from "@/server/facilities/facility-name";
import { RULE_CATALOG_VERSION } from "./text-risk-rule-catalog";
import { matchTextRisks, computeSourceTextHash } from "./text-risk-matcher";

// ---------- Constants ----------

const BATCH_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// ---------- Internal helpers ----------

function getTextRiskSeverityRank(severity: ComplaintPriority): number {
  if (severity === ComplaintPriority.CRITICAL) return 4;
  if (severity === ComplaintPriority.HIGH) return 3;
  if (severity === ComplaintPriority.MEDIUM) return 2;
  return 1;
}

function isPrismaConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

// ---------- Exported types ----------

export type StartScanOptions = Readonly<{
  importBatchId?: string;
  ruleVersion?: string;
  actor?: string;
}>;

export type ScanSummary = Readonly<{
  runId: string;
  status: TextRiskScanStatus;
  processedComplaints: number;
  matchedSignals: number;
}>;

export type AnalyzeComplaintResult = Readonly<{
  complaintId: string;
  signalsCreated: number;
  signalsUpdated: number;
}>;

// ---------- Single complaint analysis ----------

export async function analyzeComplaintTextRisks(
  complaintId: string,
  options: { actor?: string } = {}
): Promise<AnalyzeComplaintResult> {
  const complaint = await db.complaint.findUnique({
    where: { id: complaintId, isDeleted: false },
    select: {
      id: true,
      subject: true,
      description: true,
      region: true,
      facility: true,
      department: true,
    },
  });

  if (!complaint) {
    throw new Error(`Complaint ${complaintId} not found`);
  }

  const result = await applyRulesAndPersist(complaint, options.actor ?? AUDIT_ACTOR_SYSTEM);
  return result;
}

// ---------- Scan run management ----------

export async function startTextRiskScan(options: StartScanOptions = {}): Promise<ScanSummary> {
  const ruleVersion = options.ruleVersion ?? RULE_CATALOG_VERSION;
  const actor = options.actor ?? AUDIT_ACTOR_SYSTEM;
  const activeLockKey = `TEXT_RISK_ACTIVE:${ruleVersion}`;

  if (options.importBatchId) {
    const batch = await db.importBatch.findUnique({
      where: { id: options.importBatchId },
      select: { status: true },
    });
    if (!batch || batch.status !== ImportBatchStatus.CONFIRMED) {
      throw new Error("TEXT_RISK_SCAN_BATCH_NOT_CONFIRMED");
    }
  }

  const where = buildComplaintWhere(options.importBatchId);
  const totalComplaints = await db.complaint.count({ where });

  let run: { id: string };
  try {
    run = await db.textRiskScanRun.create({
      data: {
        status: TextRiskScanStatus.RUNNING,
        ruleVersion,
        importBatchId: options.importBatchId ?? null,
        totalComplaints,
        startedAt: new Date(),
        activeLockKey,
      },
      select: { id: true },
    });
  } catch (err) {
    if (isPrismaConflict(err)) {
      const active = await db.textRiskScanRun.findFirst({ where: { activeLockKey } });
      if (!active) throw new Error("TEXT_RISK_SCAN_ALREADY_RUNNING");
      const sameScope = active.importBatchId === (options.importBatchId ?? null);
      if (sameScope) {
        return {
          runId: active.id,
          status: active.status,
          processedComplaints: active.processedComplaints,
          matchedSignals: active.matchedSignals,
        };
      }
      throw new Error("TEXT_RISK_SCAN_ALREADY_RUNNING");
    }
    throw err;
  }

  await writeAuditLog(db, {
    action: "TEXT_RISK_SCAN_STARTED",
    entityType: "TextRiskScanRun",
    entityId: run.id,
    actor,
    metadata: { ruleVersion, importBatchId: options.importBatchId ?? null, totalComplaints },
  });

  processScanRun(run.id, ruleVersion, options.importBatchId, actor).catch(() => {});

  return {
    runId: run.id,
    status: TextRiskScanStatus.RUNNING,
    processedComplaints: 0,
    matchedSignals: 0,
  };
}

export async function resumeTextRiskScan(
  runId: string,
  options: { actor?: string } = {}
): Promise<ScanSummary> {
  const run = await db.textRiskScanRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("SCAN_RUN_NOT_FOUND");
  if (run.status !== TextRiskScanStatus.FAILED) throw new Error("SCAN_RUN_NOT_RESUMABLE");

  const activeLockKey = `TEXT_RISK_ACTIVE:${run.ruleVersion}`;
  try {
    await db.textRiskScanRun.update({
      where: { id: runId },
      data: {
        status: TextRiskScanStatus.RUNNING,
        activeLockKey,
        failedAt: null,
        errorCode: null,
        errorMessage: null,
        startedAt: run.startedAt ?? new Date(),
      },
    });
  } catch (err) {
    if (isPrismaConflict(err)) throw new Error("TEXT_RISK_SCAN_ALREADY_RUNNING");
    throw err;
  }

  const actor = options.actor ?? AUDIT_ACTOR_SYSTEM;
  processScanRun(runId, run.ruleVersion, run.importBatchId ?? undefined, actor).catch(() => {});

  return {
    runId,
    status: TextRiskScanStatus.RUNNING,
    processedComplaints: run.processedComplaints,
    matchedSignals: run.matchedSignals,
  };
}

// ---------- Internal scan processor ----------

function buildComplaintWhere(importBatchId?: string): Prisma.ComplaintWhereInput {
  return {
    isDeleted: false,
    ...(importBatchId ? { importBatchId } : {}),
  };
}

async function processScanRun(
  runId: string,
  ruleVersion: string,
  importBatchId: string | undefined,
  actor: string
): Promise<void> {
  try {
    // Reload run to get the cursor (for resume support)
    const run = await db.textRiskScanRun.findUnique({ where: { id: runId } });
    if (!run) return;

    const baseWhere = buildComplaintWhere(importBatchId);
    let lastId = run.lastComplaintId ?? undefined;
    let processedCount = run.processedComplaints;
    let matchedCount = run.matchedSignals;

    while (true) {
      const batch = await db.complaint.findMany({
        where: {
          ...baseWhere,
          ...(lastId ? { id: { gt: lastId } } : {}),
        },
        select: {
          id: true,
          subject: true,
          description: true,
          region: true,
          facility: true,
          department: true,
        },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
      });

      if (batch.length === 0) break;

      for (const complaint of batch) {
        const result = await applyRulesAndPersist(complaint, actor);
        matchedCount += result.signalsCreated + result.signalsUpdated;
      }

      processedCount += batch.length;
      lastId = batch[batch.length - 1]?.id ?? lastId;

      await db.textRiskScanRun.update({
        where: { id: runId },
        data: {
          processedComplaints: processedCount,
          matchedSignals: matchedCount,
          lastComplaintId: lastId,
        },
      });
    }

    await db.textRiskScanRun.update({
      where: { id: runId },
      data: {
        status: TextRiskScanStatus.COMPLETED,
        completedAt: new Date(),
        processedComplaints: processedCount,
        matchedSignals: matchedCount,
        activeLockKey: null,
      },
    });

    await writeAuditLog(db, {
      action: "TEXT_RISK_SCAN_COMPLETED",
      entityType: "TextRiskScanRun",
      entityId: runId,
      actor,
      metadata: { processedComplaints: processedCount, matchedSignals: matchedCount },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "UNKNOWN";
    await db.textRiskScanRun.update({
      where: { id: runId },
      data: {
        status: TextRiskScanStatus.FAILED,
        failedAt: new Date(),
        errorCode: "SCAN_PROCESSING_ERROR",
        errorMessage: errorMessage.slice(0, 500),
        activeLockKey: null,
      },
    });
    await writeAuditLog(db, {
      action: "TEXT_RISK_SCAN_FAILED",
      entityType: "TextRiskScanRun",
      entityId: runId,
      actor,
      metadata: { errorCode: "SCAN_PROCESSING_ERROR" },
    });
  }
}

// ---------- Rules → DB persistence ----------

type ComplaintForAnalysis = Readonly<{
  id: string;
  subject: string;
  description: string | null;
  region: string | null;
  facility: string | null;
  department: string | null;
}>;

async function applyRulesAndPersist(
  complaint: ComplaintForAnalysis,
  actor: string
): Promise<AnalyzeComplaintResult> {
  const sourceTextHash = computeSourceTextHash(complaint.subject, complaint.description);

  const matches = matchTextRisks({
    subject: complaint.subject,
    description: complaint.description,
  });

  let created = 0;
  let updated = 0;

  for (const match of matches) {
    const rank = getTextRiskSeverityRank(match.severity);
    let wasCreated = false;

    try {
      await db.textRiskSignal.create({
        data: {
          complaintId: complaint.id,
          signalType: match.signalType,
          ruleId: match.ruleId,
          ruleVersion: match.ruleVersion,
          title: match.title,
          description: `إشارة آلية مستخرجة من نص الشكوى: ${match.title}`,
          severity: match.severity,
          severityRank: rank,
          confidenceScore: match.confidenceScore,
          certainty: match.certainty,
          isOngoing: match.isOngoing,
          evidenceSpans: match.evidenceSpans as unknown as Prisma.InputJsonValue,
          normalizedEvidenceHash: match.normalizedEvidenceHash,
          sourceTextHash,
          region: complaint.region,
          facility: complaint.facility,
          department: complaint.department,
        },
      });
      wasCreated = true;
    } catch (err) {
      if (!isPrismaConflict(err)) throw err;
    }

    if (wasCreated) {
      created++;
      await writeAuditLog(db, {
        action: "TEXT_RISK_SIGNAL_DETECTED",
        entityType: "TextRiskSignal",
        entityId: complaint.id,
        actor,
        metadata: {
          ruleId: match.ruleId,
          ruleVersion: match.ruleVersion,
          signalType: match.signalType,
          severity: match.severity,
        },
      });
    } else {
      // Signal already exists — update it if source text changed and not yet reviewed
      const updateResult = await db.textRiskSignal.updateMany({
        where: {
          complaintId: complaint.id,
          ruleId: match.ruleId,
          ruleVersion: match.ruleVersion,
          normalizedEvidenceHash: match.normalizedEvidenceHash,
          sourceTextHash: { not: sourceTextHash },
          reviewStatus: { notIn: [TextRiskReviewStatus.CONFIRMED, TextRiskReviewStatus.DISMISSED] },
        },
        data: {
          confidenceScore: match.confidenceScore,
          certainty: match.certainty,
          isOngoing: match.isOngoing,
          evidenceSpans: match.evidenceSpans as unknown as Prisma.InputJsonValue,
          sourceTextHash,
          severity: match.severity,
          severityRank: rank,
        },
      });
      if (updateResult.count > 0) updated++;
    }
  }

  return { complaintId: complaint.id, signalsCreated: created, signalsUpdated: updated };
}

// ---------- List signals (for API) ----------

export type ListSignalsOptions = Readonly<{
  page?: number;
  pageSize?: number;
  signalType?: TextRiskSignalType;
  severity?: ComplaintPriority;
  reviewStatus?: TextRiskReviewStatus;
  certainty?: TextRiskCertainty;
  region?: string;
  facility?: string;
  department?: string;
  from?: string;
  to?: string;
  search?: string;
}>;

export async function listTextRiskSignals(options: ListSignalsOptions = {}) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? 20));
  const skip = (page - 1) * pageSize;

  const where = buildSignalWhere(options);

  const [items, total] = await Promise.all([
    db.textRiskSignal.findMany({
      where,
      orderBy: [{ severityRank: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      skip,
      take: pageSize,
      select: {
        id: true,
        complaintId: true,
        signalType: true,
        ruleId: true,
        ruleVersion: true,
        title: true,
        severity: true,
        confidenceScore: true,
        certainty: true,
        isOngoing: true,
        evidenceSpans: true,
        reviewStatus: true,
        region: true,
        facility: true,
        department: true,
        createdAt: true,
        reviewedAt: true,
        reviewReason: true,
      },
    }),
    db.textRiskSignal.count({ where }),
  ]);

  return { items, page, pageSize, total };
}

function buildSignalWhere(options: ListSignalsOptions): Prisma.TextRiskSignalWhereInput {
  const where: Prisma.TextRiskSignalWhereInput = {};

  if (options.signalType) where.signalType = options.signalType;
  if (options.severity) where.severity = options.severity;
  if (options.reviewStatus) where.reviewStatus = options.reviewStatus;
  if (options.certainty) where.certainty = options.certainty;
  if (options.region) where.region = options.region;
  if (options.facility) {
    where.complaint = {
      facilityNormalizedName: normalizeFacilityName(options.facility) ?? "__INVALID_FACILITY_KEY__",
    };
  }
  if (options.department) where.department = options.department;

  if (options.from || options.to) {
    where.createdAt = {};
    if (options.from) where.createdAt.gte = new Date(options.from);
    if (options.to) where.createdAt.lte = new Date(options.to);
  }

  if (options.search) {
    where.title = { contains: options.search };
  }

  return where;
}
