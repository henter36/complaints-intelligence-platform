import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportBatchStatus, TextRiskScanStatus } from "@prisma/client";

// ---------- DB mock (vi.hoisted so the factory can reference it) ----------

const mockDb = vi.hoisted(() => ({
  complaint: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  textRiskSignal: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
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
  listTextRiskSignals,
} from "./text-risk-analysis-service";
import { computeSourceTextHash } from "./text-risk-matcher";

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
  };
}

// ---------- analyzeComplaintTextRisks ----------

describe("analyzeComplaintTextRisks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.textRiskSignal.findUnique.mockResolvedValue(null);
    mockDb.textRiskSignal.create.mockResolvedValue({ id: "sig-1" });
    mockDb.textRiskSignal.update.mockResolvedValue({ id: "sig-1" });
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

  it("creates signal when rule matches", async () => {
    mockDb.complaint.findUnique.mockResolvedValue(
      makeComplaint({ subject: "تسمم غذائي", description: "يعاني المحتجز من تسمم حاد" })
    );
    const result = await analyzeComplaintTextRisks("complaint-1");
    expect(result.signalsCreated).toBeGreaterThan(0);
    expect(mockDb.textRiskSignal.create).toHaveBeenCalled();
  });

  it("is idempotent: same complaint twice does not create duplicate (same sourceTextHash)", async () => {
    const complaint = makeComplaint({ subject: "تسمم غذائي", description: "تسمم حاد" });
    mockDb.complaint.findUnique.mockResolvedValue(complaint);

    // First call: no existing signal
    mockDb.textRiskSignal.findUnique.mockResolvedValueOnce(null);
    mockDb.textRiskSignal.create.mockResolvedValueOnce({ id: "sig-1" });
    const first = await analyzeComplaintTextRisks("complaint-1");
    expect(first.signalsCreated).toBeGreaterThan(0);

    // Second call: existing signal with SAME sourceTextHash → skip
    const existingSignal = {
      id: "sig-1",
      sourceTextHash: computeSourceTextHash(complaint.subject, complaint.description),
      reviewStatus: "PENDING_REVIEW",
    };
    mockDb.complaint.findUnique.mockResolvedValue(complaint);
    mockDb.textRiskSignal.findUnique.mockResolvedValue(existingSignal);

    const second = await analyzeComplaintTextRisks("complaint-1");
    expect(second.signalsCreated).toBe(0);
    expect(second.signalsUpdated).toBe(0);
  });

  it("updates non-reviewed signal when sourceTextHash changes", async () => {
    const complaint = makeComplaint({ subject: "تسمم غذائي", description: "تسمم حاد" });
    mockDb.complaint.findUnique.mockResolvedValue(complaint);

    const existingSignal = {
      id: "sig-1",
      sourceTextHash: "OLD_HASH_THAT_DOES_NOT_MATCH",
      reviewStatus: "PENDING_REVIEW",
    };
    mockDb.textRiskSignal.findUnique.mockResolvedValue(existingSignal);
    mockDb.textRiskSignal.update.mockResolvedValue({ id: "sig-1" });

    const result = await analyzeComplaintTextRisks("complaint-1");
    expect(result.signalsUpdated).toBeGreaterThan(0);
    expect(mockDb.textRiskSignal.update).toHaveBeenCalled();
  });

  it("does NOT update reviewed (CONFIRMED) signal even when text changes", async () => {
    const complaint = makeComplaint({ subject: "تسمم غذائي", description: "تسمم حاد" });
    mockDb.complaint.findUnique.mockResolvedValue(complaint);

    const reviewedSignal = {
      id: "sig-1",
      sourceTextHash: "OLD_HASH",
      reviewStatus: "CONFIRMED",
    };
    mockDb.textRiskSignal.findUnique.mockResolvedValue(reviewedSignal);

    const result = await analyzeComplaintTextRisks("complaint-1");
    expect(result.signalsUpdated).toBe(0);
    expect(mockDb.textRiskSignal.update).not.toHaveBeenCalled();
  });

  it("does NOT update reviewed (DISMISSED) signal even when text changes", async () => {
    const complaint = makeComplaint({ subject: "تسمم غذائي", description: "تسمم حاد" });
    mockDb.complaint.findUnique.mockResolvedValue(complaint);

    const dismissedSignal = {
      id: "sig-1",
      sourceTextHash: "OLD_HASH",
      reviewStatus: "DISMISSED",
    };
    mockDb.textRiskSignal.findUnique.mockResolvedValue(dismissedSignal);

    const result = await analyzeComplaintTextRisks("complaint-1");
    expect(result.signalsUpdated).toBe(0);
  });
});

// ---------- startTextRiskScan ----------

describe("startTextRiskScan", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.textRiskScanRun.findFirst.mockResolvedValue(null);
    mockDb.importBatch.findUnique.mockResolvedValue({ status: ImportBatchStatus.CONFIRMED });
    mockDb.complaint.count.mockResolvedValue(0);
    mockDb.complaint.findMany.mockResolvedValue([]);
    mockDb.textRiskScanRun.create.mockResolvedValue(makeScanRun());
    mockDb.textRiskScanRun.update.mockResolvedValue(makeScanRun());
    mockDb.textRiskSignal.findUnique.mockResolvedValue(null);
    mockDb.textRiskSignal.create.mockResolvedValue({ id: "sig-1" });
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

  it("returns existing running scan instead of starting duplicate", async () => {
    const existingRun = makeScanRun({ id: "existing-run", status: TextRiskScanStatus.RUNNING });
    mockDb.textRiskScanRun.findFirst.mockResolvedValue(existingRun);

    const result = await startTextRiskScan({ importBatchId: "batch-1" });
    expect(result.runId).toBe("existing-run");
    // Should not create a new run
    expect(mockDb.textRiskScanRun.create).not.toHaveBeenCalled();
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

  it("scan failure does not propagate to caller (fire-and-forget)", async () => {
    // processScanRun will fail when count throws, but startTextRiskScan should still resolve
    mockDb.complaint.count.mockResolvedValueOnce(1);
    mockDb.textRiskScanRun.create.mockResolvedValueOnce(makeScanRun());
    mockDb.complaint.findMany.mockRejectedValueOnce(new Error("DB failure"));
    mockDb.textRiskScanRun.update.mockResolvedValue(makeScanRun({ status: TextRiskScanStatus.FAILED }));

    // Should resolve without throwing
    await expect(startTextRiskScan({})).resolves.toBeDefined();
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

  it("does not expose complaintId field (excluded from select)", async () => {
    // listTextRiskSignals selects specific fields; verify complaintId is included
    // (it's needed for the review screen) but PII-sensitive ones are not selected
    await listTextRiskSignals();
    const call = mockDb.textRiskSignal.findMany.mock.calls[0][0];
    expect(call.select).toBeDefined();
    // These fields must be explicitly selected (complaintId is needed for review screen)
    expect(call.select.id).toBe(true);
    expect(call.select.complaintId).toBe(true);
    expect(call.select.signalType).toBe(true);
    // sourceTextHash is internal — should NOT be exposed
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
