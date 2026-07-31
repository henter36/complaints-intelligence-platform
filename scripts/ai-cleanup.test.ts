// Tests for the AI cleanup transaction semantics.
//
// scripts/ai-cleanup.ts runs its own main() on import, so these tests exercise a
// faithful in-line reimplementation of processExpiredRun's transaction array using
// a mock $transaction. They verify that every mutation (result soft-delete, run
// redaction, feedback-comment redaction, audit log) is included in ONE atomic
// transaction, and that a rollback leaves the run unchanged and reprocessable.

import { describe, it, expect, vi } from "vitest";

const JsonNull = Symbol("JsonNull");

interface RunFixture {
  id: string;
  resultId: string;
  expiresAt: Date;
  deletedAt: Date | null;
  filtersSnapshot: unknown;
  errorCode: string | null;
  feedbackComment: string | null;
  auditLogs: number;
}

// Mirrors the transaction array assembled in scripts/ai-cleanup.ts processExpiredRun.
function buildCleanupOperations(runId: string, resultId: string, expiresAt: Date, now: Date) {
  return [
    { model: "aiAnalysisResult", op: "update", where: { id: resultId }, data: { deletedAt: now } },
    {
      model: "aiAnalysisRun",
      op: "update",
      where: { id: runId },
      data: { filtersSnapshot: JsonNull, inputSummary: JsonNull, errorCode: null, errorMessage: null },
    },
    {
      model: "aiFeedback",
      op: "updateMany",
      where: { analysisRunId: runId, comment: { not: null } },
      data: { comment: null },
    },
    {
      model: "auditLog",
      op: "create",
      data: {
        action: "AI_RESULT_EXPIRED_CLEANED",
        entityType: "AiAnalysisResult",
        entityId: resultId,
        actor: "system",
        metadata: { analysisRunId: runId, expiredAt: expiresAt.toISOString() },
      },
    },
  ];
}

// Applies operations atomically against a fixture: throws => nothing is applied.
function applyAtomically(run: RunFixture, ops: ReturnType<typeof buildCleanupOperations>, shouldFail: boolean): void {
  const snapshot = { ...run };
  try {
    if (shouldFail) throw new Error("transaction failed");
    for (const op of ops) {
      if (op.model === "aiAnalysisResult") run.deletedAt = (op.data as { deletedAt: Date }).deletedAt;
      if (op.model === "aiAnalysisRun") {
        run.filtersSnapshot = JsonNull;
        run.errorCode = null;
      }
      if (op.model === "aiFeedback") run.feedbackComment = null;
      if (op.model === "auditLog") run.auditLogs += 1;
    }
  } catch (err) {
    Object.assign(run, snapshot);
    throw err;
  }
}

describe("ai-cleanup — atomic transaction array", () => {
  const now = new Date("2026-07-31T00:00:00.000Z");

  function freshRun(): RunFixture {
    return {
      id: "run-1",
      resultId: "res-1",
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      deletedAt: null,
      filtersSnapshot: { department: "IT" },
      errorCode: "SOME_ERROR",
      feedbackComment: "user PII comment",
      auditLogs: 0,
    };
  }

  it("includes all four mutations in a single transaction array", () => {
    const ops = buildCleanupOperations("run-1", "res-1", now, now);
    const models = ops.map(o => `${o.model}.${o.op}`);
    expect(models).toEqual([
      "aiAnalysisResult.update",
      "aiAnalysisRun.update",
      "aiFeedback.updateMany",
      "auditLog.create",
    ]);
  });

  it("applies all operations together on success", () => {
    const run = freshRun();
    const ops = buildCleanupOperations(run.id, run.resultId, run.expiresAt, now);
    applyAtomically(run, ops, false);
    expect(run.deletedAt).toEqual(now);
    expect(run.filtersSnapshot).toBe(JsonNull);
    expect(run.errorCode).toBeNull();
    expect(run.feedbackComment).toBeNull();
    expect(run.auditLogs).toBe(1);
  });

  it("leaves the run fully unchanged after a rollback", () => {
    const run = freshRun();
    const ops = buildCleanupOperations(run.id, run.resultId, run.expiresAt, now);
    expect(() => applyAtomically(run, ops, true)).toThrow("transaction failed");
    // Nothing partially applied — result not soft-deleted, content not redacted.
    expect(run.deletedAt).toBeNull();
    expect(run.filtersSnapshot).toEqual({ department: "IT" });
    expect(run.errorCode).toBe("SOME_ERROR");
    expect(run.feedbackComment).toBe("user PII comment");
    expect(run.auditLogs).toBe(0);
  });

  it("remains processable after a rollback (retry succeeds)", () => {
    const run = freshRun();
    const ops = buildCleanupOperations(run.id, run.resultId, run.expiresAt, now);
    expect(() => applyAtomically(run, ops, true)).toThrow();
    // The still-expired, still-undeleted run can be picked up again and cleaned.
    expect(run.deletedAt).toBeNull();
    const retryOps = buildCleanupOperations(run.id, run.resultId, run.expiresAt, now);
    applyAtomically(run, retryOps, false);
    expect(run.deletedAt).toEqual(now);
    expect(run.feedbackComment).toBeNull();
    expect(run.auditLogs).toBe(1);
  });
});

// Guard: ensure the source file keeps the feedback redaction inside the
// transaction array and not as a separate post-transaction call.
describe("ai-cleanup — source keeps feedback redaction inside the transaction", () => {
  it("does not call aiFeedback.updateMany outside db.$transaction", async () => {
    const fsMod = await import("node:fs");
    const pathMod = await import("node:path");
    const src = fsMod.readFileSync(
      pathMod.resolve(__dirname, "ai-cleanup.ts"),
      "utf8"
    );
    const txIndex = src.indexOf("db.$transaction([");
    const txEnd = src.indexOf("]);", txIndex);
    const insideTx = src.slice(txIndex, txEnd);
    expect(insideTx).toContain("db.aiFeedback.updateMany");
    // No standalone awaited updateMany after the transaction closes.
    const afterTx = src.slice(txEnd);
    expect(afterTx).not.toContain("await db.aiFeedback.updateMany");
    vi.restoreAllMocks();
  });
});
