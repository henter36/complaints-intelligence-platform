import type { Prisma } from "@prisma/client";
import { writeAuditLog, AUDIT_ACTOR_SYSTEM } from "@/server/audit/audit-log-service";
import { assertClassificationNameDiffersFromCategory } from "./classification-management-service";
import {
  RESTRUCTURE_ERROR_CODES,
  TaxonomyRestructureError,
  buildRollbackToken,
} from "./classification-taxonomy-proposal";
import {
  RESTRUCTURE_OPERATIONS,
  RESTRUCTURE_RUN_STATUSES,
  loadCurrentTaxonomy,
  readAndValidateManifest,
  type RestructureDb,
  type RestructureManifest,
  type RestructurePlan,
} from "./classification-taxonomy-manifest";

export type RestructureExecutionCounters = {
  createdCount: number;
  renamedCount: number;
  movedCount: number;
  deactivatedCount: number;
  keywordChangeCount: number;
  legacyComplaintConsistencyUpdateCount: number;
};

export type RestructureExecutionContext = {
  tx: Prisma.TransactionClient;
  runId: string;
  actor: string;
  plan: RestructurePlan;
  categoryIdByName: Map<string, string>;
  processedClassificationIds: Set<string>;
  counters: RestructureExecutionCounters;
};

function createEmptyExecutionCounters(): RestructureExecutionCounters {
  return {
    createdCount: 0,
    renamedCount: 0,
    movedCount: 0,
    deactivatedCount: 0,
    keywordChangeCount: 0,
    legacyComplaintConsistencyUpdateCount: 0,
  };
}

async function recordItem(
  tx: Prisma.TransactionClient,
  runId: string,
  input: {
    entityType: string;
    action: string;
    entityId?: string | null;
    previousStateJson?: Prisma.InputJsonValue;
    nextStateJson?: Prisma.InputJsonValue;
  }
): Promise<void> {
  await tx.classificationTaxonomyRestructureItem.create({
    data: {
      runId,
      entityType: input.entityType,
      action: input.action,
      entityId: input.entityId ?? null,
      previousStateJson: input.previousStateJson,
      nextStateJson: input.nextStateJson,
      result: "APPLIED",
    },
  });
}

function validateApplyRequest(confirm?: string): void {
  if (!confirm) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.CONFIRMATION_REQUIRED,
      "رمز التأكيد مطلوب"
    );
  }
}

function loadValidatedApplyManifest(manifestPath: string, confirm: string): RestructureManifest {
  const manifest = readAndValidateManifest(manifestPath);
  if (confirm !== manifest.confirmationToken) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.CONFIRMATION_INVALID,
      "رمز التأكيد غير صحيح"
    );
  }
  return manifest;
}

async function assertCurrentTaxonomyMatchesPreview(
  db: RestructureDb,
  manifest: RestructureManifest
): Promise<Awaited<ReturnType<typeof loadCurrentTaxonomy>>> {
  const current = await loadCurrentTaxonomy(db);
  if (current.fingerprint !== manifest.currentTaxonomyFingerprint) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.CLASSIFICATION_TAXONOMY_CHANGED_AFTER_PREVIEW,
      "تغير القاموس الحالي بعد المعاينة"
    );
  }
  return current;
}

async function createRestructureApplyRun(
  db: RestructureDb,
  manifest: RestructureManifest,
  actor: string
) {
  return db.classificationTaxonomyRestructureRun.create({
    data: {
      operation: RESTRUCTURE_OPERATIONS.APPLY,
      status: RESTRUCTURE_RUN_STATUSES.APPLYING,
      proposalHash: manifest.proposalHash,
      mappingHash: manifest.mappingHash,
      currentTaxonomyFingerprint: manifest.currentTaxonomyFingerprint,
      targetTaxonomyFingerprint: manifest.targetTaxonomyFingerprint,
      manifestHash: manifest.manifestHash,
      actor,
    },
  });
}

async function writeRestructureStartedAudit(
  db: RestructureDb,
  runId: string,
  actor: string,
  manifest: RestructureManifest
): Promise<void> {
  await writeAuditLog(db, {
    action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_STARTED",
    entityType: "ClassificationTaxonomyRestructureRun",
    entityId: runId,
    actor,
    metadata: {
      runId,
      manifestHash: manifest.manifestHash,
      changeCount: manifest.totals.changeCount,
    },
  });
}

async function applyCategoryCreates(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.categoriesToCreate) {
    const created = await ctx.tx.category.create({ data: { nameAr: item.targetName } });
    ctx.categoryIdByName.set(item.targetName, created.id);
    ctx.counters.createdCount += 1;
    await recordItem(ctx.tx, ctx.runId, {
      entityType: "Category",
      action: "CREATE",
      entityId: created.id,
      nextStateJson: { nameAr: created.nameAr, isActive: true },
    });
  }
}

async function applyCategoryRenames(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.categoriesToRename) {
    if (!item.currentId) continue;
    const before = await ctx.tx.category.findUniqueOrThrow({ where: { id: item.currentId } });
    await ctx.tx.category.update({
      where: { id: item.currentId },
      data: { nameAr: item.targetName },
    });
    ctx.categoryIdByName.delete(before.nameAr);
    ctx.categoryIdByName.set(item.targetName, item.currentId);
    ctx.counters.renamedCount += 1;
    await recordItem(ctx.tx, ctx.runId, {
      entityType: "Category",
      action: "RENAME",
      entityId: item.currentId,
      previousStateJson: { nameAr: before.nameAr },
      nextStateJson: { nameAr: item.targetName },
    });
  }
}

function registerKeptCategories(ctx: RestructureExecutionContext): void {
  for (const item of ctx.plan.categoriesToKeep) {
    if (item.currentId) ctx.categoryIdByName.set(item.targetName, item.currentId);
  }
  for (const [name, meta] of Object.entries(ctx.plan.finalCategoryTargets)) {
    if (meta.reuseId) ctx.categoryIdByName.set(name, meta.reuseId);
  }
}

async function applyClassificationCreates(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.classificationsToCreate) {
    const categoryId = ctx.categoryIdByName.get(item.targetCategory ?? "");
    if (!categoryId) {
      throw new TaxonomyRestructureError(
        RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID,
        `فئة مفقودة لإنشاء التصنيف ${item.targetName}`
      );
    }
    assertClassificationNameDiffersFromCategory(item.targetCategory ?? "", item.targetName);
    let keywords =
      item.classificationKey != null
        ? ctx.plan.finalKeywordsByKey[item.classificationKey]
        : undefined;
    keywords ??= item.keywords;
    keywords ??= [];
    const created = await ctx.tx.classification.create({
      data: { categoryId, nameAr: item.targetName, keywords },
    });
    ctx.counters.createdCount += 1;
    if (keywords.length > 0) ctx.counters.keywordChangeCount += 1;
    await recordItem(ctx.tx, ctx.runId, {
      entityType: "Classification",
      action: "CREATE",
      entityId: created.id,
      nextStateJson: {
        nameAr: created.nameAr,
        categoryId,
        keywords,
        classificationKey: item.classificationKey,
      },
    });
  }
}

function resolveTargetCategoryId(
  ctx: RestructureExecutionContext,
  targetCategory: string | null
): string {
  if (!targetCategory) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID, "فئة هدف مفقودة");
  }
  const id = ctx.categoryIdByName.get(targetCategory);
  if (!id) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID,
      `فئة الهدف غير موجودة: ${targetCategory}`
    );
  }
  return id;
}

async function applyClassificationMovesAndRenames(ctx: RestructureExecutionContext): Promise<void> {
  const renameOrMove = [
    ...ctx.plan.classificationsToMove,
    ...ctx.plan.classificationsToRename,
    ...ctx.plan.classificationsToSplit,
  ];
  for (const item of renameOrMove) {
    if (!item.currentId || ctx.processedClassificationIds.has(item.currentId)) continue;
    ctx.processedClassificationIds.add(item.currentId);
    const before = await ctx.tx.classification.findUniqueOrThrow({ where: { id: item.currentId } });
    const targetCategoryId = resolveTargetCategoryId(ctx, item.targetCategory);
    assertClassificationNameDiffersFromCategory(item.targetCategory ?? "", item.targetName);
    const keywords =
      item.classificationKey && ctx.plan.finalKeywordsByKey[item.classificationKey]
        ? ctx.plan.finalKeywordsByKey[item.classificationKey]
        : undefined;
    await ctx.tx.classification.update({
      where: { id: item.currentId },
      data: {
        nameAr: item.targetName,
        categoryId: targetCategoryId,
        ...(keywords ? { keywords } : {}),
      },
    });
    if (before.categoryId !== targetCategoryId) {
      ctx.counters.movedCount += 1;
      const updated = await ctx.tx.complaint.updateMany({
        where: { isDeleted: false, classificationId: item.currentId },
        data: { categoryId: targetCategoryId },
      });
      ctx.counters.legacyComplaintConsistencyUpdateCount += updated.count;
      await recordItem(ctx.tx, ctx.runId, {
        entityType: "Complaint",
        action: "CATEGORY_CONSISTENCY",
        entityId: item.currentId,
        previousStateJson: { categoryId: before.categoryId },
        nextStateJson: { categoryId: targetCategoryId, updatedCount: updated.count },
      });
    } else {
      ctx.counters.renamedCount += 1;
    }
    if (keywords) ctx.counters.keywordChangeCount += 1;
    await recordItem(ctx.tx, ctx.runId, {
      entityType: "Classification",
      action: before.categoryId !== targetCategoryId ? "MOVE_AND_RENAME" : "RENAME",
      entityId: item.currentId,
      previousStateJson: {
        nameAr: before.nameAr,
        categoryId: before.categoryId,
        keywords: before.keywords as Prisma.InputJsonValue,
      },
      nextStateJson: {
        nameAr: item.targetName,
        categoryId: targetCategoryId,
        keywords: (keywords ?? before.keywords) as Prisma.InputJsonValue,
      },
    });
  }
}

async function applyRemainingKeywordUpdates(ctx: RestructureExecutionContext): Promise<void> {
  for (const [key, keywords] of Object.entries(ctx.plan.finalKeywordsByKey)) {
    const target = ctx.plan.finalClassificationTargets[key];
    if (!target?.reuseId || ctx.processedClassificationIds.has(target.reuseId)) continue;
    const before = await ctx.tx.classification.findUniqueOrThrow({ where: { id: target.reuseId } });
    await ctx.tx.classification.update({ where: { id: target.reuseId }, data: { keywords } });
    ctx.counters.keywordChangeCount += 1;
    await recordItem(ctx.tx, ctx.runId, {
      entityType: "Classification",
      action: "KEYWORDS",
      entityId: target.reuseId,
      previousStateJson: { keywords: before.keywords as Prisma.InputJsonValue },
      nextStateJson: { keywords },
    });
  }
}

async function applyClassificationDeactivations(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.classificationsToDeactivate) {
    if (!item.currentId) continue;
    const before = await ctx.tx.classification.findUniqueOrThrow({ where: { id: item.currentId } });
    if (!before.isActive) continue;
    await ctx.tx.classification.update({
      where: { id: item.currentId },
      data: { isActive: false },
    });
    ctx.counters.deactivatedCount += 1;
    await recordItem(ctx.tx, ctx.runId, {
      entityType: "Classification",
      action: "DEACTIVATE",
      entityId: item.currentId,
      previousStateJson: { isActive: true },
      nextStateJson: { isActive: false },
    });
  }
}

async function applyCategoryDeactivations(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.categoriesToDeactivate) {
    if (!item.currentId) continue;
    const before = await ctx.tx.category.findUniqueOrThrow({ where: { id: item.currentId } });
    if (!before.isActive) continue;
    await ctx.tx.category.update({ where: { id: item.currentId }, data: { isActive: false } });
    ctx.counters.deactivatedCount += 1;
    await recordItem(ctx.tx, ctx.runId, {
      entityType: "Category",
      action: "DEACTIVATE",
      entityId: item.currentId,
      previousStateJson: { isActive: true },
      nextStateJson: { isActive: false },
    });
  }
}

async function assertComplaintCategoryConsistency(ctx: RestructureExecutionContext): Promise<void> {
  const bad = await ctx.tx.complaint.findMany({
    where: { isDeleted: false, classificationId: { not: null } },
    select: { categoryId: true, classification: { select: { categoryId: true } } },
  });
  for (const c of bad) {
    if (c.classification && c.categoryId === c.classification.categoryId) continue;
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.CATEGORY_CLASSIFICATION_MISMATCH,
      "اختلاف categoryId عن classification.categoryId بعد التطبيق"
    );
  }
}

async function executeRestructurePlan(input: {
  db: RestructureDb;
  runId: string;
  actor: string;
  plan: RestructurePlan;
  currentCategories: Array<{ nameAr: string; id: string }>;
}): Promise<RestructureExecutionCounters> {
  return input.db.$transaction(
    async (tx) => {
      const counters = createEmptyExecutionCounters();
      const ctx: RestructureExecutionContext = {
        tx,
        runId: input.runId,
        actor: input.actor,
        plan: input.plan,
        categoryIdByName: new Map(input.currentCategories.map((c) => [c.nameAr, c.id])),
        processedClassificationIds: new Set(),
        counters,
      };
      await applyCategoryCreates(ctx);
      await applyCategoryRenames(ctx);
      registerKeptCategories(ctx);
      await applyClassificationCreates(ctx);
      await applyClassificationMovesAndRenames(ctx);
      await applyRemainingKeywordUpdates(ctx);
      await applyClassificationDeactivations(ctx);
      await applyCategoryDeactivations(ctx);
      await assertComplaintCategoryConsistency(ctx);
      return counters;
    },
    { timeout: 180_000 }
  );
}

async function finalizeSuccessfulRestructureRun(input: {
  db: RestructureDb;
  runId: string;
  actor: string;
  counters: RestructureExecutionCounters;
  manifest: RestructureManifest;
}) {
  await input.db.classificationTaxonomyRestructureRun.update({
    where: { id: input.runId },
    data: {
      status: RESTRUCTURE_RUN_STATUSES.APPLIED,
      completedAt: new Date(),
      ...input.counters,
    },
  });
  await writeAuditLog(input.db, {
    action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_APPLIED",
    entityType: "ClassificationTaxonomyRestructureRun",
    entityId: input.runId,
    actor: input.actor,
    metadata: { runId: input.runId, ...input.counters },
  });
  return {
    mode: "apply" as const,
    runId: input.runId,
    status: RESTRUCTURE_RUN_STATUSES.APPLIED,
    ...input.counters,
    rollbackToken: buildRollbackToken(
      input.runId,
      input.manifest.manifestHash,
      input.counters.createdCount + input.counters.renamedCount + input.counters.movedCount
    ),
  };
}

async function finalizeFailedRestructureRun(input: {
  db: RestructureDb;
  runId: string;
  actor: string;
  error: unknown;
}): Promise<never> {
  const message =
    input.error instanceof Error ? input.error.message.slice(0, 200) : "UNEXPECTED_ERROR";
  const code =
    input.error instanceof TaxonomyRestructureError ? input.error.code : "APPLY_FAILED";
  // Transaction rolled back → committed mutation counters are zero.
  const counters = createEmptyExecutionCounters();
  await input.db.classificationTaxonomyRestructureRun.update({
    where: { id: input.runId },
    data: {
      status: RESTRUCTURE_RUN_STATUSES.FAILED,
      completedAt: new Date(),
      failureCode: code,
      failureMessage: message,
      ...counters,
    },
  });
  await writeAuditLog(input.db, {
    action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_FAILED",
    entityType: "ClassificationTaxonomyRestructureRun",
    entityId: input.runId,
    actor: input.actor,
    metadata: { runId: input.runId, failureCode: code },
  });
  throw input.error;
}

export async function applyTaxonomyRestructure(
  db: RestructureDb,
  input: { manifestPath: string; confirm?: string; actor?: string }
) {
  validateApplyRequest(input.confirm);
  const actor = input.actor ?? AUDIT_ACTOR_SYSTEM;
  const manifest = loadValidatedApplyManifest(input.manifestPath, input.confirm!);
  const current = await assertCurrentTaxonomyMatchesPreview(db, manifest);
  const run = await createRestructureApplyRun(db, manifest, actor);
  await writeRestructureStartedAudit(db, run.id, actor, manifest);

  try {
    const counters = await executeRestructurePlan({
      db,
      runId: run.id,
      actor,
      plan: manifest.plan,
      currentCategories: current.categories,
    });
    return await finalizeSuccessfulRestructureRun({
      db,
      runId: run.id,
      actor,
      counters,
      manifest,
    });
  } catch (error) {
    return await finalizeFailedRestructureRun({ db, runId: run.id, actor, error });
  }
}
