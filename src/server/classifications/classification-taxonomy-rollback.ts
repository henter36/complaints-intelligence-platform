import type { Prisma } from "@prisma/client";
import { writeAuditLog, AUDIT_ACTOR_SYSTEM } from "@/server/audit/audit-log-service";
import {
  RESTRUCTURE_ERROR_CODES,
  TaxonomyRestructureError,
  buildRollbackToken,
} from "./classification-taxonomy-proposal";
import {
  RESTRUCTURE_OPERATIONS,
  RESTRUCTURE_RUN_STATUSES,
  createRestructureItemSequence,
  type RestructureDb,
  type RestructureItemSequence,
} from "./classification-taxonomy-manifest";

type AppliedItem = {
  id: string;
  sequence: number;
  entityType: string;
  action: string;
  entityId: string | null;
  previousStateJson: Prisma.JsonValue | null;
  nextStateJson: Prisma.JsonValue | null;
};

type RollbackItemDecision =
  | { action: "DEACTIVATE_CREATED_CATEGORY"; entityId: string }
  | { action: "DEACTIVATE_CREATED_CLASSIFICATION"; entityId: string }
  | { action: "REACTIVATE_CATEGORY"; entityId: string }
  | { action: "REACTIVATE_CLASSIFICATION"; entityId: string }
  | {
      action: "RESTORE_CATEGORY";
      entityId: string;
      previous: Record<string, unknown>;
    }
  | {
      action: "RESTORE_CLASSIFICATION";
      entityId: string;
      previous: Record<string, unknown>;
    }
  | {
      action: "RESTORE_COMPLAINT_CATEGORY";
      entityId: string;
      previousCategoryId: string;
      appliedCategoryId?: string;
    }
  | { action: "SKIP"; reason: string; entityId?: string | null };

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validateRollbackRequest(confirm?: string): void {
  if (!confirm) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.CONFIRMATION_REQUIRED,
      "رمز تأكيد التراجع مطلوب"
    );
  }
}

async function loadOriginalRestructureRun(db: RestructureDb, runId: string) {
  const original = await db.classificationTaxonomyRestructureRun.findUnique({
    where: { id: runId },
  });
  if (!original) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.RUN_NOT_FOUND, "التشغيل غير موجود");
  }
  return original;
}

function assertRollbackConfirmation(
  original: { id: string; manifestHash: string; createdCount: number; renamedCount: number; movedCount: number },
  confirm: string
): void {
  const appliedOps = original.createdCount + original.renamedCount + original.movedCount;
  const expected = buildRollbackToken(original.id, original.manifestHash, appliedOps);
  if (confirm !== expected) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.CONFIRMATION_INVALID,
      "رمز تأكيد التراجع غير صحيح"
    );
  }
}

async function createRollbackRun(
  db: RestructureDb,
  original: {
    id: string;
    proposalHash: string;
    mappingHash: string;
    currentTaxonomyFingerprint: string;
    targetTaxonomyFingerprint: string;
    manifestHash: string;
  },
  actor: string
) {
  return db.classificationTaxonomyRestructureRun.create({
    data: {
      operation: RESTRUCTURE_OPERATIONS.ROLLBACK,
      status: RESTRUCTURE_RUN_STATUSES.ROLLING_BACK,
      proposalHash: original.proposalHash,
      mappingHash: original.mappingHash,
      currentTaxonomyFingerprint: original.targetTaxonomyFingerprint,
      targetTaxonomyFingerprint: original.currentTaxonomyFingerprint,
      manifestHash: original.manifestHash,
      actor,
      rollbackOfRunId: original.id,
    },
  });
}

async function loadAppliedRestructureItems(db: RestructureDb, originalRunId: string): Promise<AppliedItem[]> {
  return db.classificationTaxonomyRestructureItem.findMany({
    where: { runId: originalRunId, result: "APPLIED" },
    orderBy: [{ sequence: "desc" }, { id: "desc" }],
  });
}

function optionalStringMatches(
  expected: unknown,
  actual: string | undefined
): boolean {
  if (typeof expected !== "string") return true;
  return actual === expected;
}

function optionalBooleanMatches(
  expected: unknown,
  actual: boolean | undefined
): boolean {
  if (typeof expected !== "boolean") return true;
  return actual === expected;
}

async function categoryMatchesNextState(
  tx: Prisma.TransactionClient,
  entityId: string,
  next: Record<string, unknown>
): Promise<boolean> {
  const current = await tx.category.findUnique({ where: { id: entityId } });
  if (!current) return false;
  return (
    optionalStringMatches(next.nameAr, current.nameAr) &&
    optionalBooleanMatches(next.isActive, current.isActive)
  );
}

async function classificationMatchesNextState(
  tx: Prisma.TransactionClient,
  entityId: string,
  next: Record<string, unknown>
): Promise<boolean> {
  const current = await tx.classification.findUnique({ where: { id: entityId } });
  if (!current) return false;
  return (
    optionalStringMatches(next.nameAr, current.nameAr) &&
    optionalStringMatches(next.categoryId, current.categoryId) &&
    optionalBooleanMatches(next.isActive, current.isActive)
  );
}

async function entityMatchesNextState(
  tx: Prisma.TransactionClient,
  item: AppliedItem
): Promise<boolean> {
  const next = asRecord(item.nextStateJson);
  if (!item.entityId || !next) return true;
  if (item.entityType === "Category") {
    return categoryMatchesNextState(tx, item.entityId, next);
  }
  if (item.entityType === "Classification") {
    return classificationMatchesNextState(tx, item.entityId, next);
  }
  return true;
}

async function skipIfEntityDrifted(
  tx: Prisma.TransactionClient,
  item: AppliedItem
): Promise<RollbackItemDecision | null> {
  const matches = await entityMatchesNextState(tx, item);
  if (matches) return null;
  return { action: "SKIP", reason: "ENTITY_CHANGED_AFTER_APPLY", entityId: item.entityId };
}

async function evaluateCreatedRollback(
  tx: Prisma.TransactionClient,
  item: AppliedItem
): Promise<RollbackItemDecision | null> {
  if (item.action !== "CREATE" || !item.entityId) return null;
  const drift = await skipIfEntityDrifted(tx, item);
  if (drift) return drift;
  if (item.entityType === "Classification") {
    return { action: "DEACTIVATE_CREATED_CLASSIFICATION", entityId: item.entityId };
  }
  if (item.entityType === "Category") {
    return { action: "DEACTIVATE_CREATED_CATEGORY", entityId: item.entityId };
  }
  return { action: "SKIP", reason: "UNSUPPORTED_OR_MISSING_STATE", entityId: item.entityId };
}

async function evaluateDeactivatedRollback(
  tx: Prisma.TransactionClient,
  item: AppliedItem
): Promise<RollbackItemDecision | null> {
  if (item.action !== "DEACTIVATE" || !item.entityId) return null;
  const drift = await skipIfEntityDrifted(tx, item);
  if (drift) return drift;
  if (item.entityType === "Classification") {
    return { action: "REACTIVATE_CLASSIFICATION", entityId: item.entityId };
  }
  if (item.entityType === "Category") {
    return { action: "REACTIVATE_CATEGORY", entityId: item.entityId };
  }
  return { action: "SKIP", reason: "UNSUPPORTED_OR_MISSING_STATE", entityId: item.entityId };
}

async function evaluateRestoredRollback(
  tx: Prisma.TransactionClient,
  item: AppliedItem,
  prev: Record<string, unknown> | null
): Promise<RollbackItemDecision | null> {
  const isRestoreAction =
    item.action === "RENAME" || item.action === "MOVE_AND_RENAME" || item.action === "KEYWORDS";
  if (!isRestoreAction || !item.entityId || !prev) return null;
  const drift = await skipIfEntityDrifted(tx, item);
  if (drift) return drift;
  if (item.entityType === "Category" && typeof prev.nameAr === "string") {
    return { action: "RESTORE_CATEGORY", entityId: item.entityId, previous: prev };
  }
  if (item.entityType === "Classification") {
    return { action: "RESTORE_CLASSIFICATION", entityId: item.entityId, previous: prev };
  }
  return { action: "SKIP", reason: "UNSUPPORTED_OR_MISSING_STATE", entityId: item.entityId };
}

function evaluateComplaintConsistencyRollback(
  item: AppliedItem,
  prev: Record<string, unknown> | null
): RollbackItemDecision | null {
  if (item.action !== "CATEGORY_CONSISTENCY" || !item.entityId || !prev) return null;
  if (typeof prev.categoryId !== "string") return null;
  const next = asRecord(item.nextStateJson);
  return {
    action: "RESTORE_COMPLAINT_CATEGORY",
    entityId: item.entityId,
    previousCategoryId: prev.categoryId,
    appliedCategoryId:
      next && typeof next.categoryId === "string" ? next.categoryId : undefined,
  };
}

async function evaluateRollbackItem(
  tx: Prisma.TransactionClient,
  item: AppliedItem
): Promise<RollbackItemDecision> {
  const prev = asRecord(item.previousStateJson);
  return (
    (await evaluateCreatedRollback(tx, item)) ??
    (await evaluateDeactivatedRollback(tx, item)) ??
    (await evaluateRestoredRollback(tx, item, prev)) ??
    evaluateComplaintConsistencyRollback(item, prev) ?? {
      action: "SKIP",
      reason: "UNSUPPORTED_OR_MISSING_STATE",
      entityId: item.entityId,
    }
  );
}

async function processRollbackItem(
  tx: Prisma.TransactionClient,
  decision: RollbackItemDecision
): Promise<"ROLLED_BACK" | "SKIPPED"> {
  switch (decision.action) {
    case "DEACTIVATE_CREATED_CATEGORY":
      await tx.category.update({ where: { id: decision.entityId }, data: { isActive: false } });
      return "ROLLED_BACK";
    case "DEACTIVATE_CREATED_CLASSIFICATION":
      await tx.classification.update({
        where: { id: decision.entityId },
        data: { isActive: false },
      });
      return "ROLLED_BACK";
    case "REACTIVATE_CATEGORY":
      await tx.category.update({ where: { id: decision.entityId }, data: { isActive: true } });
      return "ROLLED_BACK";
    case "REACTIVATE_CLASSIFICATION":
      await tx.classification.update({
        where: { id: decision.entityId },
        data: { isActive: true },
      });
      return "ROLLED_BACK";
    case "RESTORE_CATEGORY":
      await tx.category.update({
        where: { id: decision.entityId },
        data: { nameAr: String(decision.previous.nameAr) },
      });
      return "ROLLED_BACK";
    case "RESTORE_CLASSIFICATION":
      await tx.classification.update({
        where: { id: decision.entityId },
        data: {
          ...(typeof decision.previous.nameAr === "string"
            ? { nameAr: decision.previous.nameAr }
            : {}),
          ...(typeof decision.previous.categoryId === "string"
            ? { categoryId: decision.previous.categoryId }
            : {}),
          ...(decision.previous.keywords !== undefined
            ? { keywords: decision.previous.keywords as Prisma.InputJsonValue }
            : {}),
        },
      });
      return "ROLLED_BACK";
    case "RESTORE_COMPLAINT_CATEGORY":
      await tx.complaint.updateMany({
        where: {
          classificationId: decision.entityId,
          isDeleted: false,
          ...(decision.appliedCategoryId
            ? { categoryId: decision.appliedCategoryId }
            : {}),
        },
        data: { categoryId: decision.previousCategoryId },
      });
      return "ROLLED_BACK";
    case "SKIP":
      return "SKIPPED";
  }
}

async function executeRollbackTransaction(input: {
  db: RestructureDb;
  items: AppliedItem[];
  rollbackRunId: string;
}): Promise<{ rolledBack: number; skipped: number; skipReasons: string[] }> {
  return input.db.$transaction(
    async (tx) => {
      let rolledBack = 0;
      let skipped = 0;
      const skipReasons: string[] = [];
      const itemSequence = createRestructureItemSequence();
      for (const item of input.items) {
        const decision = await evaluateRollbackItem(tx, item);
        const result = await processRollbackItem(tx, decision);
        if (result === "ROLLED_BACK") {
          rolledBack += 1;
          await tx.classificationTaxonomyRestructureItem.update({
            where: { id: item.id },
            data: { result: "ROLLED_BACK" },
          });
          await recordRollbackItem(tx, input.rollbackRunId, itemSequence, item, "ROLLED_BACK");
        } else {
          skipped += 1;
          const reason = decision.action === "SKIP" ? decision.reason : "SKIPPED";
          skipReasons.push(reason);
          await tx.classificationTaxonomyRestructureItem.update({
            where: { id: item.id },
            data: { result: "ROLLBACK_SKIPPED", skipReason: reason },
          });
          await recordRollbackItem(
            tx,
            input.rollbackRunId,
            itemSequence,
            item,
            "ROLLBACK_SKIPPED",
            reason
          );
        }
      }
      return { rolledBack, skipped, skipReasons };
    },
    { timeout: 180_000 }
  );
}

async function recordRollbackItem(
  tx: Prisma.TransactionClient,
  rollbackRunId: string,
  itemSequence: RestructureItemSequence,
  item: AppliedItem,
  result: "ROLLED_BACK" | "ROLLBACK_SKIPPED",
  skipReason?: string
): Promise<void> {
  await tx.classificationTaxonomyRestructureItem.create({
    data: {
      runId: rollbackRunId,
      sequence: itemSequence.next(),
      entityType: item.entityType,
      action: item.action,
      entityId: item.entityId,
      previousStateJson: item.nextStateJson ?? undefined,
      nextStateJson: item.previousStateJson ?? undefined,
      result,
      skipReason,
    },
  });
}

function resolveRollbackRunStatus(skipped: number): string {
  return skipped > 0
    ? RESTRUCTURE_RUN_STATUSES.PARTIALLY_ROLLED_BACK
    : RESTRUCTURE_RUN_STATUSES.ROLLED_BACK;
}

async function finalizeRollbackRun(input: {
  db: RestructureDb;
  rollbackRunId: string;
  originalRunId: string;
  status: string;
  rolledBack: number;
  skipped: number;
}): Promise<void> {
  await input.db.classificationTaxonomyRestructureRun.update({
    where: { id: input.rollbackRunId },
    data: {
      status: input.status,
      completedAt: new Date(),
      createdCount: input.rolledBack,
      renamedCount: input.skipped,
    },
  });
  await input.db.classificationTaxonomyRestructureRun.update({
    where: { id: input.originalRunId },
    data: { status: input.status },
  });
}

async function writeRollbackAudit(input: {
  db: RestructureDb;
  rollbackRunId: string;
  originalRunId: string;
  actor: string;
  rolledBack: number;
  skipped: number;
  skipReasons: string[];
}): Promise<void> {
  await writeAuditLog(input.db, {
    action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_ROLLED_BACK",
    entityType: "ClassificationTaxonomyRestructureRun",
    entityId: input.rollbackRunId,
    actor: input.actor,
    metadata: {
      runId: input.rollbackRunId,
      originalRunId: input.originalRunId,
      rolledBack: input.rolledBack,
      skipped: input.skipped,
      skipReasons: input.skipReasons,
    },
  });
}

function buildRollbackResult(input: {
  rollbackRunId: string;
  originalRunId: string;
  status: string;
  rolledBack: number;
  skipped: number;
}) {
  return {
    mode: "rollback" as const,
    runId: input.rollbackRunId,
    originalRunId: input.originalRunId,
    status: input.status,
    rolledBack: input.rolledBack,
    skipped: input.skipped,
  };
}

export async function rollbackTaxonomyRestructure(
  db: RestructureDb,
  input: { runId: string; confirm?: string; actor?: string }
) {
  validateRollbackRequest(input.confirm);
  const actor = input.actor ?? AUDIT_ACTOR_SYSTEM;
  const original = await loadOriginalRestructureRun(db, input.runId);
  assertRollbackConfirmation(original, input.confirm!);
  const rollbackRun = await createRollbackRun(db, original, actor);
  const items = await loadAppliedRestructureItems(db, original.id);
  const outcome = await executeRollbackTransaction({
    db,
    items,
    rollbackRunId: rollbackRun.id,
  });
  const status = resolveRollbackRunStatus(outcome.skipped);
  await finalizeRollbackRun({
    db,
    rollbackRunId: rollbackRun.id,
    originalRunId: original.id,
    status,
    rolledBack: outcome.rolledBack,
    skipped: outcome.skipped,
  });
  await writeRollbackAudit({
    db,
    rollbackRunId: rollbackRun.id,
    originalRunId: original.id,
    actor,
    rolledBack: outcome.rolledBack,
    skipped: outcome.skipped,
    skipReasons: outcome.skipReasons,
  });
  return buildRollbackResult({
    rollbackRunId: rollbackRun.id,
    originalRunId: original.id,
    status,
    rolledBack: outcome.rolledBack,
    skipped: outcome.skipped,
  });
}
