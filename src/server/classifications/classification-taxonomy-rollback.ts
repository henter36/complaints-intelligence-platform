import type { Prisma } from "@prisma/client";
import { writeAuditLog, AUDIT_ACTOR_SYSTEM } from "@/server/audit/audit-log-service";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import { parseClassificationKeywords } from "./classification-keywords";
import { compareCodeUnits } from "./canonical-string-order";
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
      complaintId: string;
      classificationId: string;
      previousCategoryId: string;
      appliedCategoryId: string;
    }
  | { action: "SKIP"; reason: string; entityId?: string | null };

const NON_ROLLBACKABLE_STATUSES = new Set<string>([
  RESTRUCTURE_RUN_STATUSES.FAILED,
  RESTRUCTURE_RUN_STATUSES.APPLYING,
  RESTRUCTURE_RUN_STATUSES.ROLLING_BACK,
  RESTRUCTURE_RUN_STATUSES.ROLLED_BACK,
  RESTRUCTURE_RUN_STATUSES.PARTIALLY_ROLLED_BACK,
]);

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

function assertRollbackAllowed(original: {
  operation: string;
  status: string;
}): void {
  if (original.operation === RESTRUCTURE_OPERATIONS.ROLLBACK) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.ROLLBACK_NOT_ALLOWED,
      "لا يمكن التراجع عن تشغيل تراجع"
    );
  }
  if (NON_ROLLBACKABLE_STATUSES.has(original.status)) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.ROLLBACK_NOT_ALLOWED,
      `حالة التشغيل لا تسمح بالتراجع: ${original.status}`
    );
  }
}

function assertRollbackConfirmation(
  original: {
    id: string;
    manifestHash: string;
    createdCount: number;
    renamedCount: number;
    movedCount: number;
  },
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
      createdCount: 0,
      renamedCount: 0,
      movedCount: 0,
      rolledBackCount: 0,
      skippedCount: 0,
    },
  });
}

async function loadAppliedRestructureItems(
  db: RestructureDb,
  originalRunId: string
): Promise<AppliedItem[]> {
  return db.classificationTaxonomyRestructureItem.findMany({
    where: { runId: originalRunId, result: "APPLIED" },
    orderBy: [{ sequence: "desc" }, { id: "desc" }],
  });
}

function optionalStringMatches(expected: unknown, actual: string | undefined): boolean {
  if (typeof expected !== "string") return true;
  return actual === expected;
}

function optionalBooleanMatches(expected: unknown, actual: boolean | undefined): boolean {
  if (typeof expected !== "boolean") return true;
  return actual === expected;
}

export function canonicalizeKeywordsForComparison(value: unknown): string[] | null {
  try {
    const parsed = parseClassificationKeywords(value ?? []);
    const normalized = parsed
      .map((kw) => normalizeClassificationKeyword(kw))
      .filter((kw) => kw.length > 0);
    const unique = [...new Set(normalized)];
    unique.sort(compareCodeUnits);
    return unique;
  } catch {
    return null;
  }
}

export function keywordsMatch(expected: unknown, actual: unknown): boolean {
  const left = canonicalizeKeywordsForComparison(expected);
  const right = canonicalizeKeywordsForComparison(actual);
  if (left === null || right === null) return false;
  if (left.length !== right.length) return false;
  return left.every((kw, index) => kw === right[index]);
}

function optionalKeywordsMatch(
  next: Record<string, unknown>,
  actualKeywords: unknown
): boolean {
  if (!Object.hasOwn(next, "keywords")) return true;
  return keywordsMatch(next.keywords, actualKeywords);
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
    optionalBooleanMatches(next.isActive, current.isActive) &&
    optionalKeywordsMatch(next, current.keywords)
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

async function evaluateReactivatedRollback(
  tx: Prisma.TransactionClient,
  item: AppliedItem
): Promise<RollbackItemDecision | null> {
  if (item.action !== "REACTIVATE" || !item.entityId) return null;
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
  if (!next || typeof next.categoryId !== "string") return null;
  let classificationId: string | null = null;
  if (typeof prev.classificationId === "string") {
    classificationId = prev.classificationId;
  } else if (typeof next.classificationId === "string") {
    classificationId = next.classificationId;
  }
  if (!classificationId) return null;
  return {
    action: "RESTORE_COMPLAINT_CATEGORY",
    complaintId: item.entityId,
    classificationId,
    previousCategoryId: prev.categoryId,
    appliedCategoryId: next.categoryId,
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
    (await evaluateReactivatedRollback(tx, item)) ??
    (await evaluateRestoredRollback(tx, item, prev)) ??
    evaluateComplaintConsistencyRollback(item, prev) ?? {
      action: "SKIP",
      reason: "UNSUPPORTED_OR_MISSING_STATE",
      entityId: item.entityId,
    }
  );
}

function tempRollbackCategoryName(runId: string, entityId: string): string {
  return `__taxonomy_tmp_rb_category_${runId}_${entityId}`;
}

function tempRollbackClassificationName(runId: string, entityId: string): string {
  return `__taxonomy_tmp_rb_classification_${runId}_${entityId}`;
}

async function stageRollbackTemporaryNames(
  tx: Prisma.TransactionClient,
  rollbackRunId: string,
  decisions: RollbackItemDecision[]
): Promise<void> {
  for (const decision of decisions) {
    if (decision.action === "RESTORE_CATEGORY") {
      await tx.category.update({
        where: { id: decision.entityId },
        data: { nameAr: tempRollbackCategoryName(rollbackRunId, decision.entityId) },
      });
    } else if (
      decision.action === "RESTORE_CLASSIFICATION" &&
      typeof decision.previous.nameAr === "string"
    ) {
      await tx.classification.update({
        where: { id: decision.entityId },
        data: { nameAr: tempRollbackClassificationName(rollbackRunId, decision.entityId) },
      });
    }
  }
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
    case "RESTORE_COMPLAINT_CATEGORY": {
      const updated = await tx.complaint.updateMany({
        where: {
          id: decision.complaintId,
          isDeleted: false,
          classificationId: decision.classificationId,
          categoryId: decision.appliedCategoryId,
        },
        data: { categoryId: decision.previousCategoryId },
      });
      return updated.count === 1 ? "ROLLED_BACK" : "SKIPPED";
    }
    case "SKIP":
      return "SKIPPED";
  }
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
      const evaluated: Array<{ item: AppliedItem; decision: RollbackItemDecision }> = [];
      for (const item of input.items) {
        evaluated.push({ item, decision: await evaluateRollbackItem(tx, item) });
      }
      await stageRollbackTemporaryNames(
        tx,
        input.rollbackRunId,
        evaluated.map((entry) => entry.decision)
      );
      for (const { item, decision } of evaluated) {
        let result = await processRollbackItem(tx, decision);
        let reason = decision.action === "SKIP" ? decision.reason : "SKIPPED";
        if (
          decision.action === "RESTORE_COMPLAINT_CATEGORY" &&
          result === "SKIPPED"
        ) {
          reason = "COMPLAINT_CHANGED_AFTER_APPLY";
        }
        if (result === "ROLLED_BACK") {
          rolledBack += 1;
          await tx.classificationTaxonomyRestructureItem.update({
            where: { id: item.id },
            data: { result: "ROLLED_BACK" },
          });
          await recordRollbackItem(tx, input.rollbackRunId, itemSequence, item, "ROLLED_BACK");
        } else {
          skipped += 1;
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
      createdCount: 0,
      renamedCount: 0,
      movedCount: 0,
      rolledBackCount: input.rolledBack,
      skippedCount: input.skipped,
    },
  });
  await input.db.classificationTaxonomyRestructureRun.update({
    where: { id: input.originalRunId },
    data: {
      status: input.status,
      rolledBackCount: input.rolledBack,
      skippedCount: input.skipped,
    },
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
      skipReasonCodes: [...new Set(input.skipReasons)],
    },
  });
}

export async function rollbackTaxonomyRestructure(
  db: RestructureDb,
  input: { runId: string; confirm?: string; actor?: string }
) {
  validateRollbackRequest(input.confirm);
  const actor = input.actor ?? AUDIT_ACTOR_SYSTEM;
  const original = await loadOriginalRestructureRun(db, input.runId);
  assertRollbackAllowed(original);
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
  return {
    mode: "rollback" as const,
    runId: rollbackRun.id,
    originalRunId: original.id,
    status,
    rolledBack: outcome.rolledBack,
    skipped: outcome.skipped,
  };
}
