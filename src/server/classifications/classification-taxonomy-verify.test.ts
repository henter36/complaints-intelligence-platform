import { describe, expect, it, vi } from "vitest";
import { RESTRUCTURE_OPERATIONS, RESTRUCTURE_RUN_STATUSES } from "./classification-taxonomy-manifest";
import { verifyTaxonomyRestructure } from "./classification-taxonomy-verify";

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    operation: RESTRUCTURE_OPERATIONS.APPLY,
    status: RESTRUCTURE_RUN_STATUSES.APPLIED,
    proposalHash: "p",
    mappingHash: "m",
    currentTaxonomyFingerprint: "c",
    targetTaxonomyFingerprint: "t",
    manifestHash: "h",
    actor: "system",
    ...overrides,
  };
}

function mockDb(run: ReturnType<typeof baseRun>) {
  const update = vi.fn(async () => run);
  const db = {
    classificationTaxonomyRestructureRun: {
      findUnique: vi.fn(async () => run),
      update,
    },
    category: {
      findMany: vi.fn(async () => [{ id: "c1", nameAr: "فئة", isActive: true, isDeleted: false }]),
    },
    classification: {
      findMany: vi.fn(async () => []),
    },
    complaint: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    auditLog: {
      create: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(),
  };
  return db;
}

describe("verifyTaxonomyRestructure rollback protection", () => {
  it("does not write VERIFY_FAILED over ROLLED_BACK", async () => {
    const run = baseRun({
      operation: RESTRUCTURE_OPERATIONS.APPLY,
      status: RESTRUCTURE_RUN_STATUSES.ROLLED_BACK,
    });
    const db = mockDb(run);
    const result = await verifyTaxonomyRestructure(db as never, { runId: run.id });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(RESTRUCTURE_RUN_STATUSES.ROLLED_BACK);
    expect(db.classificationTaxonomyRestructureRun.update).not.toHaveBeenCalled();
  });

  it("does not mutate PARTIALLY_ROLLED_BACK or ROLLBACK operation runs", async () => {
    for (const run of [
      baseRun({ status: RESTRUCTURE_RUN_STATUSES.PARTIALLY_ROLLED_BACK }),
      baseRun({
        operation: RESTRUCTURE_OPERATIONS.ROLLBACK,
        status: RESTRUCTURE_RUN_STATUSES.ROLLED_BACK,
      }),
    ]) {
      const db = mockDb(run);
      const result = await verifyTaxonomyRestructure(db as never, { runId: run.id });
      expect(result.status).toBe(run.status);
      expect(db.classificationTaxonomyRestructureRun.update).not.toHaveBeenCalled();
    }
  });

  it("restores APPLIED after a successful re-verify of VERIFY_FAILED", async () => {
    const run = baseRun({ status: RESTRUCTURE_RUN_STATUSES.VERIFY_FAILED });
    const db = mockDb(run);
    // Force apply-path verify with empty taxonomy counts that pass >= expected only when
    // proposal is omitted (legacy fallback expects 11/27) — provide empty proposal paths
    // so we stay on apply path with failing counts unless we stub categories/classifications.
    db.category.findMany = vi.fn(async () =>
      Array.from({ length: 11 }, (_, i) => ({
        id: `c${i}`,
        nameAr: `فئة-${i}`,
        isActive: true,
        isDeleted: false,
      }))
    );
    db.classification.findMany = vi.fn(async () =>
      Array.from({ length: 27 }, (_, i) => ({
        id: `cls${i}`,
        nameAr: `تصنيف-${i}`,
        keywords: [],
        isActive: true,
        isDeleted: false,
        category: {
          id: `c${i % 11}`,
          nameAr: `فئة-${i % 11}`,
          isActive: true,
          isDeleted: false,
        },
      }))
    );

    const result = await verifyTaxonomyRestructure(db as never, { runId: run.id });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(RESTRUCTURE_RUN_STATUSES.APPLIED);
    expect(db.classificationTaxonomyRestructureRun.update).toHaveBeenCalledWith({
      where: { id: run.id },
      data: { status: RESTRUCTURE_RUN_STATUSES.APPLIED },
    });
  });
});
