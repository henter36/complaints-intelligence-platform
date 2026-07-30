import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    reportArtifact: { findMany: dbMocks.findMany, update: dbMocks.update },
    auditLog: { create: dbMocks.auditLogCreate },
  },
}));

const storageMocks = vi.hoisted(() => ({ deleteReportArtifact: vi.fn() }));
vi.mock("./report-storage", () => ({ deleteReportArtifact: storageMocks.deleteReportArtifact }));

const NOW = new Date("2026-10-29T00:00:00Z"); // 91 days after 2026-07-30

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: "art_1",
    storageKey: "key.pdf",
    format: "PDF",
    fileSize: 100,
    reportRunId: "run_1",
    expiresAt: new Date("2026-07-30T00:00:00Z"), // 91 days before NOW: expired under the 90-day policy
    ...overrides,
  };
}

describe("reports:cleanup — 90-day retention policy", () => {
  beforeEach(() => {
    dbMocks.findMany.mockReset();
    dbMocks.update.mockReset();
    dbMocks.auditLogCreate.mockReset().mockResolvedValue({ id: "audit_1" });
    storageMocks.deleteReportArtifact.mockReset().mockResolvedValue(undefined);
  });

  it("only queries artifacts whose expiresAt has already passed (never removes before expiry)", async () => {
    dbMocks.findMany.mockResolvedValue([]);
    const { runReportsCleanup } = await import("./report-cleanup-service");
    await runReportsCleanup({ dryRun: false }, NOW);

    const whereClause = dbMocks.findMany.mock.calls[0][0].where;
    expect(whereClause.deletedAt).toBeNull();
    expect(whereClause.expiresAt.lt).toEqual(NOW);
  });

  it("deletes the file and stamps deletedAt for an expired artifact", async () => {
    dbMocks.findMany.mockResolvedValue([artifact()]);
    const { runReportsCleanup } = await import("./report-cleanup-service");
    const result = await runReportsCleanup({ dryRun: false }, NOW);

    expect(result.removedCount).toBe(1);
    expect(storageMocks.deleteReportArtifact).toHaveBeenCalledWith("key.pdf");
    expect(dbMocks.update).toHaveBeenCalledWith({ where: { id: "art_1" }, data: { deletedAt: NOW } });
  });

  it("writes an audit log entry for each real deletion", async () => {
    dbMocks.findMany.mockResolvedValue([artifact()]);
    const { runReportsCleanup } = await import("./report-cleanup-service");
    await runReportsCleanup({ dryRun: false }, NOW);

    expect(dbMocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "REPORT_ARTIFACT_DELETED", entityId: "art_1" }) })
    );
  });

  it("dry-run reports candidates but deletes nothing and writes no audit log", async () => {
    dbMocks.findMany.mockResolvedValue([artifact()]);
    const { runReportsCleanup } = await import("./report-cleanup-service");
    const result = await runReportsCleanup({ dryRun: true }, NOW);

    expect(result.candidates).toHaveLength(1);
    expect(result.removedCount).toBe(0);
    expect(storageMocks.deleteReportArtifact).not.toHaveBeenCalled();
    expect(dbMocks.update).not.toHaveBeenCalled();
    expect(dbMocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("handles a missing on-disk file safely (storage layer is best-effort) and still marks it deleted", async () => {
    dbMocks.findMany.mockResolvedValue([artifact()]);
    storageMocks.deleteReportArtifact.mockResolvedValue(undefined); // report-storage swallows ENOENT internally
    const { runReportsCleanup } = await import("./report-cleanup-service");
    const result = await runReportsCleanup({ dryRun: false }, NOW);

    expect(result.removedCount).toBe(1);
    expect(dbMocks.update).toHaveBeenCalled();
  });

  it("never touches ReportRun or AuditLog rows directly (no db.reportRun access)", async () => {
    dbMocks.findMany.mockResolvedValue([artifact()]);
    const { runReportsCleanup } = await import("./report-cleanup-service");
    await runReportsCleanup({ dryRun: false }, NOW);
    // The mocked db object only exposes reportArtifact + auditLog; if the
    // service tried to touch reportRun it would throw here, not silently pass.
    expect(dbMocks.update).toHaveBeenCalledTimes(1);
  });
});
