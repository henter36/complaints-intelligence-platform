import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportBatchStatus, TextRiskScanStatus } from "@prisma/client";

// ---------- DB mock ----------

const mockDb = vi.hoisted(() => ({
  complaint: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  textRiskSignal: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  textRiskScanRun: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  importBatch: {
    findUnique: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/server/audit/audit-log-service", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AUDIT_ACTOR_SYSTEM: "SYSTEM",
}));

import {
  analyzeComplaintTextRisks,
  startTextRiskScan,
  resumeTextRiskScan,
  listTextRiskSignals,
} from "./text-risk-analysis-service";

// ---------- Fixtures ----------

function makeComplaint(overrides: Partial<{
  id: string;
  subject: string;
  description: string | null;
  region: string | null;
  facility: string | null;
  department: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "complaint-1",
    subject: overrides.subject ?? "شكوى",
    description: overrides.description ?? null,
    region: overrides.region ?? null,
    facility: overrides.facility ?? null,
    department: overrides.department ?? null,
  };
}

function makeScanRun(overrides: Partial<{
  id: string;
  status: TextRiskScanStatus;
  ruleVersion: string;
  importBatchId: string | null;
  processedComplaints: number;
  matchedSignals: number;
  lastComplaintId: string | null;
  startedAt: Date | null;
  activeLockKey: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "run-1",
    status: overrides.status ?? TextRiskScanStatus.RUNNING,
    ruleVersion: overrides.ruleVersion ?? "rule-v1",
    importBatchId: overrides.importBatchId ?? null,
    processedComplaints: overrides.processedComplaints ?? 0,
    matchedSignals: overrides.matchedSignals ?? 0,
    lastComplaintId: overrides.lastComplaintId ?? null,
    startedAt: overrides.startedAt ?? new Date(),
    activeLockKey: overrides.activeLockKey ?? null,
  };
}

function makePrismaConflict(): Error & { code: string } {
  const err = new Error("Unique constraint failed") as Error & { code: string };
  err.code = "P2002";
  return err;
}

// ---------- analyzeComplaintTextRisks ----------

describe("analyzeComplaintTextRisks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.textRiskSignal.create.mockResolvedValue({ id: "sig-1" });
    mockDb.textRiskSignal.updateMany.mockResolvedValue({ count: 0 });
    mockDb.auditLog.create.mockResolvedValue(undefined);
  });

  it("throws when complaint not found", async () => {
    mockDb.complaint.findUnique.mockResolvedValue(null);
    await expect(analyzeComplaintTextRisks("missing-id")).rejects.toThrow("missing-id");
  });

  it("returns signalsCreated=0 when no rules match", async () => {
    mockDb.complaint.findUnique.mockResolvedValue(
      makeComplaint({ subject: "طلب تجديد وثائق", description: "لا يوجد مشكلة" })
    );
    const result = await analyzeComplaintTextRisks("complaint-1");
    expect(result.signalsCreated).toBe(0);
    expect(result.signalsUpdated).toBe(0);
  });

  it("creates signal when rule matches and sets severityRank", async () => {
    mockDb.complaint.findUnique.mockResolvedValue(
      makeComplaint({ subject: "تسمم غذائي", description: "يعاني المحتجز من تسمم حاد" })
    );
    const result = await analyzeComplaintTextRisks("complaint-1");
    expect(result.signalsCreated).toBeGreaterThan(0);
    expect(mockDb.textRiskSignal.create).toHaveBeenCalled();
    const createData = mockDb.textRiskSignal.create.mock.calls[0][0].data;
    expect(typeof createData.severityRank).toBe("number");
    expect(createData.severityRank).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent: P2002 on create + updateMany finds no stale → signalsUpdated=0", async () => {
    const complaint = makeComplaint({ subject: "تسمم غذائي", description: "تسمم حاد" });
    mockDb.complaint.findUnique.mockResolvedValue(complaint);

    // Simulate duplicate: create throws P2002, updateMany finds 0 rows (same hash)
    mockDb.textRiskSignal.create.mockRejectedValue(makePrismaConflict());
    mockDb.textRiskSignal.updateMany.mockResolvedValue({ count: 0 });

    const result = await analyzeComplaintTextRisks("complaint-1");
    expect(result.signalsCreated).toBe(0);
    expect(result.signalsUpdated).toBe(0);
  });

  it("updates non-reviewed signal when P2002 on create and updateMany returns count>0", async () => {
    const complaint = makeComplaint({ subject: "تسمم غذائي", description: "تسمم حاد" });
    mockDb.complaint.findUnique.mockResolvedValue(complaint);

    mockDb.textRiskSignal.create.mockRejectedValue(makePrismaConflict());
    mockDb.textRiskSignal.updateMany.mockResolvedValue({ count: 1 });

    const result = await analyzeComplaintTextRisks("complaint-1");
    expect(result.signalsUpdated).toBeGreaterThan(0);
    expect(mockDb.textRiskSignal.updateMany).toHaveBeenCalled();
  });

  it("updateMany call excludes CONFIRMED and DISMISSED signals", async () => {
    const complaint = makeComplaint({ subject: "تسمم غذائي", description: "تسمم حاد" });
    mockDb.complaint.findUnique.mockResolvedValue(complaint);

    mockDb.textRiskSignal.create.mockRejectedValue(makePrismaConflict());
    mockDb.textRiskSignal.updateMany.mockResolvedValue({ count: 0 });

    await analyzeComplaintTextRisks("complaint-1");

    const updateManyCall = mockDb.textRiskSignal.updateMany.mock.calls[0][0];
    expect(updateManyCall.where.reviewStatus.notIn).toContain("CONFIRMED");
    expect(updateManyCall.where.reviewStatus.notIn).toContain("DISMISSED");
  });

  it("updateMany includes severityRank in data", async () => {
    const complaint = makeComplaint({ subject: "تسمم غذائي", description: "تسمم حاد" });
    mockDb.complaint.findUnique.mockResolvedValue(complaint);

    mockDb.textRiskSignal.create.mockRejectedValue(makePrismaConflict());
    mockDb.textRiskSignal.updateMany.mockResolvedValue({ count: 1 });

    await analyzeComplaintTextRisks("complaint-1");

    const updateManyCall = mockDb.textRiskSignal.updateMany.mock.calls[0][0];
    expect(typeof updateManyCall.data.severityRank).toBe("number");
  });

  it("propagates non-P2002 errors from signal create", async () => {
    const complaint = makeComplaint({ subject: "تسمم غذائي", description: "تسمم حاد" });
    mockDb.complaint.findUnique.mockResolvedValue(complaint);

    mockDb.textRiskSignal.create.mockRejectedValue(new Error("DB_TIMEOUT"));

    await expect(analyzeComplaintTextRisks("complaint-1")).rejects.toThrow("DB_TIMEOUT");
  });
});

// ---------- startTextRiskScan ----------

describe("startTextRiskScan", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.importBatch.findUnique.mockResolvedValue({ status: ImportBatchStatus.CONFIRMED });
    mockDb.complaint.count.mockResolvedValue(0);
    mockDb.complaint.findMany.mockResolvedValue([]);
    mockDb.textRiskScanRun.create.mockResolvedValue(makeScanRun());
    mockDb.textRiskScanRun.update.mockResolvedValue(makeScanRun());
    mockDb.textRiskSignal.create.mockResolvedValue({ id: "sig-1" });
    mockDb.textRiskSignal.updateMany.mockResolvedValue({ count: 0 });
    mockDb.auditLog.create.mockResolvedValue(undefined);
  });

  it("throws TEXT_RISK_SCAN_BATCH_NOT_CONFIRMED when batch not confirmed", async () => {
    mockDb.importBatch.findUnique.mockResolvedValue({ status: ImportBatchStatus.UPLOADED });
    await expect(
      startTextRiskScan({ importBatchId: "batch-1" })
    ).rejects.toThrow("TEXT_RISK_SCAN_BATCH_NOT_CONFIRMED");
  });

  it("throws TEXT_RISK_SCAN_BATCH_NOT_CONFIRMED when batch not found", async () => {
    mockDb.importBatch.findUnique.mockResolvedValue(null);
    await expect(
      startTextRiskScan({ importBatchId: "missing-batch" })
    ).rejects.toThrow("TEXT_RISK_SCAN_BATCH_NOT_CONFIRMED");
  });

  it("returns existing running scan (same scope) when P2002 on create", async () => {
    const existingRun = makeScanRun({
      id: "existing-run",
      status: TextRiskScanStatus.RUNNING,
      importBatchId: "batch-1",
      activeLockKey: "TEXT_RISK_ACTIVE:rule-v1",
    });
    mockDb.textRiskScanRun.create.mockRejectedValue(makePrismaConflict());
    mockDb.textRiskScanRun.findFirst.mockResolvedValue(existingRun);

    const result = await startTextRiskScan({ importBatchId: "batch-1" });
    expect(result.runId).toBe("existing-run");
    expect(mockDb.textRiskScanRun.create).toHaveBeenCalledTimes(1);
  });

  it("throws TEXT_RISK_SCAN_ALREADY_RUNNING when P2002 on create and scope differs", async () => {
    // Global scan is active (importBatchId=null), but we're trying a batch scan
    const existingRun = makeScanRun({
      id: "global-run",
      importBatchId: null,
      activeLockKey: "TEXT_RISK_ACTIVE:rule-v1",
    });
    mockDb.textRiskScanRun.create.mockRejectedValue(makePrismaConflict());
    mockDb.textRiskScanRun.findFirst.mockResolvedValue(existingRun);

    await expect(
      startTextRiskScan({ importBatchId: "batch-1" })
    ).rejects.toThrow("TEXT_RISK_SCAN_ALREADY_RUNNING");
  });

  it("throws TEXT_RISK_SCAN_ALREADY_RUNNING when P2002 and findFirst returns nothing", async () => {
    mockDb.textRiskScanRun.create.mockRejectedValue(makePrismaConflict());
    mockDb.textRiskScanRun.findFirst.mockResolvedValue(null);

    await expect(startTextRiskScan({})).rejects.toThrow("TEXT_RISK_SCAN_ALREADY_RUNNING");
  });

  it("returns RUNNING status after starting scan", async () => {
    const result = await startTextRiskScan({ importBatchId: "batch-1" });
    expect(result.status).toBe(TextRiskScanStatus.RUNNING);
  });

  it("starts global scan (no importBatchId) without checking batch status", async () => {
    const result = await startTextRiskScan({});
    expect(result.status).toBe(TextRiskScanStatus.RUNNING);
    expect(mockDb.importBatch.findUnique).not.toHaveBeenCalled();
  });

  it("passes activeLockKey to textRiskScanRun.create", async () => {
    await startTextRiskScan({ ruleVersion: "test-v99" });
    const createData = mockDb.textRiskScanRun.create.mock.calls[0][0].data;
    expect(createData.activeLockKey).toBe("TEXT_RISK_ACTIVE:test-v99");
  });

  it("scan failure does not propagate to caller (fire-and-forget)", async () => {
    mockDb.complaint.count.mockResolvedValueOnce(1);
    mockDb.complaint.findMany.mockRejectedValueOnce(new Error("DB failure"));
    mockDb.textRiskScanRun.update.mockResolvedValue(makeScanRun({ status: TextRiskScanStatus.FAILED }));

    await expect(startTextRiskScan({})).resolves.toBeDefined();
  });
});

// ---------- resumeTextRiskScan ----------

describe("resumeTextRiskScan", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.complaint.findMany.mockResolvedValue([]);
    mockDb.textRiskScanRun.update.mockResolvedValue(makeScanRun());
    mockDb.auditLog.create.mockResolvedValue(undefined);
  });

  it("throws SCAN_RUN_NOT_FOUND when run does not exist", async () => {
    mockDb.textRiskScanRun.findUnique.mockResolvedValue(null);
    await expect(resumeTextRiskScan("missing-run")).rejects.toThrow("SCAN_RUN_NOT_FOUND");
  });

  it("throws SCAN_RUN_NOT_RESUMABLE when run is not FAILED", async () => {
    mockDb.textRiskScanRun.findUnique.mockResolvedValue(
      makeScanRun({ status: TextRiskScanStatus.COMPLETED })
    );
    await expect(resumeTextRiskScan("run-1")).rejects.toThrow("SCAN_RUN_NOT_RESUMABLE");
  });

  it("resumes a FAILED scan and returns RUNNING", async () => {
    mockDb.textRiskScanRun.findUnique.mockResolvedValue(
      makeScanRun({ status: TextRiskScanStatus.FAILED })
    );
    const result = await resumeTextRiskScan("run-1");
    expect(result.status).toBe(TextRiskScanStatus.RUNNING);
  });

  it("passes activeLockKey to update on resume", async () => {
    mockDb.textRiskScanRun.findUnique.mockResolvedValue(
      makeScanRun({ status: TextRiskScanStatus.FAILED, ruleVersion: "v42" })
    );
    await resumeTextRiskScan("run-1");
    const updateData = mockDb.textRiskScanRun.update.mock.calls[0][0].data;
    expect(updateData.activeLockKey).toBe("TEXT_RISK_ACTIVE:v42");
  });

  it("throws TEXT_RISK_SCAN_ALREADY_RUNNING when P2002 on update during resume", async () => {
    mockDb.textRiskScanRun.findUnique.mockResolvedValue(
      makeScanRun({ status: TextRiskScanStatus.FAILED })
    );
    mockDb.textRiskScanRun.update.mockRejectedValue(makePrismaConflict());

    await expect(resumeTextRiskScan("run-1")).rejects.toThrow("TEXT_RISK_SCAN_ALREADY_RUNNING");
  });
});

// ---------- listTextRiskSignals ----------

describe("listTextRiskSignals", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.textRiskSignal.findMany.mockResolvedValue([]);
    mockDb.textRiskSignal.count.mockResolvedValue(0);
  });

  it("returns empty list when no signals", async () => {
    const result = await listTextRiskSignals();
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("uses default pagination (page=1, pageSize=20)", async () => {
    await listTextRiskSignals();
    const findManyCall = mockDb.textRiskSignal.findMany.mock.calls[0][0];
    expect(findManyCall.skip).toBe(0);
    expect(findManyCall.take).toBe(20);
  });

  it("orders by severityRank desc, then createdAt desc, then id asc", async () => {
    await listTextRiskSignals();
    const findManyCall = mockDb.textRiskSignal.findMany.mock.calls[0][0];
    expect(findManyCall.orderBy).toEqual([
      { severityRank: "desc" },
      { createdAt: "desc" },
      { id: "asc" },
    ]);
  });

  it("applies severity filter", async () => {
    await listTextRiskSignals({ severity: "CRITICAL" });
    const call = mockDb.textRiskSignal.findMany.mock.calls[0][0];
    expect(call.where.severity).toBe("CRITICAL");
  });

  it("applies reviewStatus filter", async () => {
    await listTextRiskSignals({ reviewStatus: "PENDING_REVIEW" });
    const call = mockDb.textRiskSignal.findMany.mock.calls[0][0];
    expect(call.where.reviewStatus).toBe("PENDING_REVIEW");
  });

  it("applies signalType filter", async () => {
    await listTextRiskSignals({ signalType: "POISONING" });
    const call = mockDb.textRiskSignal.findMany.mock.calls[0][0];
    expect(call.where.signalType).toBe("POISONING");
  });

  it("clamps page size to MAX_PAGE_SIZE", async () => {
    await listTextRiskSignals({ pageSize: 9999 });
    const call = mockDb.textRiskSignal.findMany.mock.calls[0][0];
    expect(call.take).toBe(100);
  });

  it("select includes id, complaintId, signalType but not sourceTextHash", async () => {
    await listTextRiskSignals();
    const call = mockDb.textRiskSignal.findMany.mock.calls[0][0];
    expect(call.select).toBeDefined();
    expect(call.select.id).toBe(true);
    expect(call.select.complaintId).toBe(true);
    expect(call.select.signalType).toBe(true);
    expect(call.select.sourceTextHash).toBeUndefined();
  });

  it("applies from/to date filters", async () => {
    await listTextRiskSignals({ from: "2026-01-01", to: "2026-12-31" });
    const call = mockDb.textRiskSignal.findMany.mock.calls[0][0];
    expect(call.where.createdAt?.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt?.lte).toBeInstanceOf(Date);
  });

  it("applies region filter", async () => {
    await listTextRiskSignals({ region: "منطقة الرياض" });
    const call = mockDb.textRiskSignal.findMany.mock.calls[0][0];
    expect(call.where.region).toBe("منطقة الرياض");
  });
});
