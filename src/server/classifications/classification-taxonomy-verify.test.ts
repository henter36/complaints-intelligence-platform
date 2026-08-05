import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { RESTRUCTURE_OPERATIONS, RESTRUCTURE_RUN_STATUSES } from "./classification-taxonomy-manifest";
import { RESTRUCTURE_ERROR_CODES } from "./classification-taxonomy-proposal";
import { verifyTaxonomyRestructure } from "./classification-taxonomy-verify";

const FIXTURE_DIR = join(process.cwd(), "src/server/classifications/__fixtures__");
const PROPOSAL = join(FIXTURE_DIR, "mini-proposed-taxonomy.json");
const MAPPING = join(FIXTURE_DIR, "mini-source-detail-mapping.csv");

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
    rollbackOfRunId: null,
    rolledBackCount: 0,
    skippedCount: 0,
    ...overrides,
  };
}

function mockDb(run: ReturnType<typeof baseRun>) {
  const update = vi.fn(async () => run);
  return {
    classificationTaxonomyRestructureRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === run.id) return run;
        if (run.rollbackOfRunId && where.id === run.rollbackOfRunId) {
          return baseRun({
            id: run.rollbackOfRunId,
            operation: RESTRUCTURE_OPERATIONS.APPLY,
            status: RESTRUCTURE_RUN_STATUSES.ROLLED_BACK,
            currentTaxonomyFingerprint: "pre",
            targetTaxonomyFingerprint: "post",
          });
        }
        return null;
      }),
      update,
    },
    classificationTaxonomyRestructureItem: {
      findMany: vi.fn(async () => []),
    },
    category: {
      findMany: vi.fn(async () => []),
    },
    classification: {
      findMany: vi.fn(async () => []),
    },
    complaint: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
    },
    auditLog: {
      create: vi.fn(async () => ({})),
    },
    $queryRaw: vi.fn(async () => [{ count: 0 }]),
    $transaction: vi.fn(),
  };
}

describe("verifyTaxonomyRestructure", () => {
  it("requires proposal and mapping", async () => {
    const db = mockDb(baseRun());
    await expect(
      verifyTaxonomyRestructure(db as never, { runId: "run_1" })
    ).rejects.toMatchObject({ code: RESTRUCTURE_ERROR_CODES.PROPOSAL_REQUIRED });
    await expect(
      verifyTaxonomyRestructure(db as never, {
        runId: "run_1",
        proposalPath: PROPOSAL,
      })
    ).rejects.toMatchObject({ code: RESTRUCTURE_ERROR_CODES.MAPPING_REQUIRED });
  });

  it("does not write VERIFY_FAILED over ROLLED_BACK", async () => {
    const run = baseRun({
      operation: RESTRUCTURE_OPERATIONS.APPLY,
      status: RESTRUCTURE_RUN_STATUSES.ROLLED_BACK,
      currentTaxonomyFingerprint: "pre",
    });
    const db = mockDb(run);
    db.category.findMany = vi.fn(async () => []);
    db.classification.findMany = vi.fn(async () => []);
    // live fingerprint won't match — still must not mutate status
    const result = await verifyTaxonomyRestructure(db as never, {
      runId: run.id,
      proposalPath: PROPOSAL,
      mappingPath: MAPPING,
    });
    expect(result.status).toBe(RESTRUCTURE_RUN_STATUSES.ROLLED_BACK);
    expect(db.classificationTaxonomyRestructureRun.update).not.toHaveBeenCalled();
  });

  it("does not mutate PARTIALLY_ROLLED_BACK or ROLLBACK operation runs", async () => {
    for (const run of [
      baseRun({ status: RESTRUCTURE_RUN_STATUSES.PARTIALLY_ROLLED_BACK }),
      baseRun({
        operation: RESTRUCTURE_OPERATIONS.ROLLBACK,
        status: RESTRUCTURE_RUN_STATUSES.ROLLED_BACK,
        rollbackOfRunId: "apply_1",
      }),
    ]) {
      const db = mockDb(run);
      const result = await verifyTaxonomyRestructure(db as never, {
        runId: run.id,
        proposalPath: PROPOSAL,
        mappingPath: MAPPING,
      });
      expect(result.status).toBe(run.status);
      expect(db.classificationTaxonomyRestructureRun.update).not.toHaveBeenCalled();
    }
  });

  it("treats ROLLING_BACK as unsuccessful", async () => {
    const run = baseRun({ status: RESTRUCTURE_RUN_STATUSES.ROLLING_BACK });
    const db = mockDb(run);
    const result = await verifyTaxonomyRestructure(db as never, {
      runId: run.id,
      proposalPath: PROPOSAL,
      mappingPath: MAPPING,
    });
    expect(result.ok).toBe(false);
  });
});
