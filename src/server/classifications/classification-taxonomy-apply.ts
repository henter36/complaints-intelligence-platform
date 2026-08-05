import type { Prisma } from "@prisma/client";
import { writeAuditLog, AUDIT_ACTOR_SYSTEM } from "@/server/audit/audit-log-service";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import { assertClassificationNameDiffersFromCategory } from "./classification-management-service";
import {
  RESTRUCTURE_ERROR_CODES,
  TaxonomyRestructureError,
  buildRollbackToken,
} from "./classification-taxonomy-proposal";
import {
  RESTRUCTURE_OPERATIONS,
  RESTRUCTURE_RUN_STATUSES,
  createRestructureItemSequence,
  loadCurrentTaxonomy,
  loadReactivationStateSnapshot,
  computeReactivationStateFingerprint,
  readAndValidateManifest,
  type RestructureDb,
  type RestructureItemSequence,
  type RestructureManifest,
  type RestructurePlan,
} from "./classification-taxonomy-manifest";
import { assertPlanIsApplicable } from "./classification-taxonomy-plan";

export type RestructureExecutionCounters = {
  createdCount: number;
  renamedCount: number;
  movedCount: number;
  deactivatedCount: number;
  keywordChangeCount: number;
  legacyComplaintConsistencyUpdateCount: number;
};

export type CurrentTaxonomy = Awaited<ReturnType<typeof loadCurrentTaxonomy>>;

export type RestructureExecutionContext = {
  tx: Prisma.TransactionClient;
  runId: string;
  actor: string;
  plan: RestructurePlan;
  categoryIdByFinalName: Map<string, string>;
  categoryIdByOriginalName: Map<string, string>;
  categoryIdByTemporaryName: Map<string, string>;
  processedClassificationIds: Set<string>;
  counters: RestructureExecutionCounters;
  itemSequence: RestructureItemSequence;
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
  ctx: RestructureExecutionContext,
  input: {
    entityType: string;
    action: string;
    entityId?: string | null;
    previousStateJson?: Prisma.InputJsonValue;
    nextStateJson?: Prisma.InputJsonValue;
  }
): Promise<void> {
  await ctx.tx.classificationTaxonomyRestructureItem.create({
    data: {
      runId: ctx.runId,
      sequence: ctx.itemSequence.next(),
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
): Promise<CurrentTaxonomy> {
  const current = await loadCurrentTaxonomy(db);
  if (current.fingerprint !== manifest.currentTaxonomyFingerprint) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.CLASSIFICATION_TAXONOMY_CHANGED_AFTER_PREVIEW,
      "تغير القاموس الحالي بعد المعاينة"
    );
  }
  return current;
}

async function assertReactivationStateMatchesPreview(
  db: RestructureDb,
  manifest: RestructureManifest
): Promise<void> {
  const live = await loadReactivationStateSnapshot(db, manifest.plan);
  const actual = computeReactivationStateFingerprint(live);
  if (actual === manifest.reactivationStateFingerprint) return;
  throw new TaxonomyRestructureError(
    RESTRUCTURE_ERROR_CODES.REACTIVATION_STATE_CHANGED_AFTER_PREVIEW,
    "تغيرت حالة الكيانات المخطط لإعادة تفعيلها بعد المعاينة",
    {
      expectedFingerprintPrefix: manifest.reactivationStateFingerprint.slice(0, 12),
      actualFingerprintPrefix: actual.slice(0, 12),
      changedEntityCount: live.categories.length + live.classifications.length,
    }
  );
}

function tempCategoryName(runId: string, entityId: string): string {
  return `__taxonomy_tmp_category_${runId}_${entityId}`;
}

function tempClassificationName(runId: string, entityId: string): string {
  return `__taxonomy_tmp_classification_${runId}_${entityId}`;
}

function throwRenameCollision(message: string): never {
  throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.TAXONOMY_RENAME_COLLISION, message);
}

function buildFinalCategoryNameOwners(plan: RestructurePlan): Map<string, string> {
  const owners = new Map<string, string>();
  for (const name of Object.keys(plan.finalCategoryTargets)) {
    const key = normalizeClassificationKeyword(name);
    if (owners.has(key)) throwRenameCollision("تكرار اسم فئة مستهدفة");
    owners.set(key, name);
  }
  return owners;
}

function assertUniqueCategoryRenameTargets(plan: RestructurePlan): Map<string, string> {
  const renameTargetOwners = new Map<string, string>();
  for (const item of plan.categoriesToRename) {
    const key = normalizeClassificationKeyword(item.targetName);
    const owner = item.currentId ?? "";
    const prior = renameTargetOwners.get(key);
    if (prior !== undefined && prior !== owner) {
      throwRenameCollision("تكرار إعادة تسمية فئات إلى نفس الاسم المستهدف");
    }
    renameTargetOwners.set(key, owner);
  }
  return renameTargetOwners;
}

function reusedCategoryIdsFromPlan(plan: RestructurePlan): Set<string> {
  return new Set(
    Object.values(plan.finalCategoryTargets)
      .map((t) => t.reuseId)
      .filter((id): id is string => Boolean(id))
  );
}

function reusedClassificationIdsFromPlan(plan: RestructurePlan): Set<string> {
  return new Set(
    Object.values(plan.finalClassificationTargets)
      .map((t) => t.reuseId)
      .filter((id): id is string => Boolean(id))
  );
}

function assertCategoryCreatesDoNotCollide(
  current: CurrentTaxonomy,
  plan: RestructurePlan,
  renameTargetOwners: Map<string, string>
): void {
  const reusedCategoryIds = reusedCategoryIdsFromPlan(plan);
  for (const create of plan.categoriesToCreate) {
    const targetNorm = normalizeClassificationKeyword(create.targetName);
    if (renameTargetOwners.has(targetNorm)) {
      throwRenameCollision("إنشاء فئة يصطدم بإعادة تسمية إلى نفس الاسم");
    }
    const hasActiveBlocker = current.categories.some(
      (c) =>
        c.isActive &&
        !c.isDeleted &&
        !reusedCategoryIds.has(c.id) &&
        normalizeClassificationKeyword(c.nameAr) === targetNorm
    );
    if (hasActiveBlocker) throwRenameCollision("إنشاء فئة يصطدم باسم قائم");
  }
}

function assertFinalClassificationPathsUnique(plan: RestructurePlan): void {
  const finalPaths = new Map<string, string>();
  for (const [clsKey, target] of Object.entries(plan.finalClassificationTargets)) {
    const pathKey = `${normalizeClassificationKeyword(target.categoryName)}\0${normalizeClassificationKeyword(target.classificationName)}`;
    if (finalPaths.has(pathKey)) throwRenameCollision("تكرار مسار تصنيف مستهدف");
    finalPaths.set(pathKey, clsKey);
  }
}

function assertInactiveCategoryCreateCollisions(
  current: CurrentTaxonomy,
  plan: RestructurePlan
): void {
  const reusedCategoryIds = reusedCategoryIdsFromPlan(plan);
  for (const create of plan.categoriesToCreate) {
    const targetNorm = normalizeClassificationKeyword(create.targetName);
    const hasInactiveBlocker = current.categories.some(
      (c) =>
        !c.isActive &&
        !c.isDeleted &&
        !reusedCategoryIds.has(c.id) &&
        normalizeClassificationKeyword(c.nameAr) === targetNorm
    );
    if (hasInactiveBlocker) throwRenameCollision("إنشاء فئة يصطدم باسم قائم");
  }
}

function resolveCreateTargetCategoryId(
  current: CurrentTaxonomy,
  plan: RestructurePlan,
  targetCategory: string | null
): string | undefined {
  if (!targetCategory) return undefined;
  const planned = plan.finalCategoryTargets[targetCategory]?.reuseId;
  if (planned) return planned;
  return current.categories.find(
    (c) =>
      normalizeClassificationKeyword(c.nameAr) === normalizeClassificationKeyword(targetCategory)
  )?.id;
}

function assertInactiveClassificationCreateCollisions(
  current: CurrentTaxonomy,
  plan: RestructurePlan
): void {
  const reusedClassificationIds = reusedClassificationIdsFromPlan(plan);
  for (const create of plan.classificationsToCreate) {
    const targetCatId = resolveCreateTargetCategoryId(current, plan, create.targetCategory);
    if (!targetCatId) continue;
    const nameNorm = normalizeClassificationKeyword(create.targetName);
    const hasBlocker = current.classifications.some(
      (c) =>
        !reusedClassificationIds.has(c.id) &&
        c.categoryId === targetCatId &&
        normalizeClassificationKeyword(c.nameAr) === nameNorm
    );
    if (hasBlocker) throwRenameCollision("إنشاء تصنيف يصطدم بمسار قائم");
  }
}

function assertNoRenameCollisions(current: CurrentTaxonomy, plan: RestructurePlan): void {
  buildFinalCategoryNameOwners(plan);
  const renameTargetOwners = assertUniqueCategoryRenameTargets(plan);
  assertCategoryCreatesDoNotCollide(current, plan, renameTargetOwners);
  assertFinalClassificationPathsUnique(plan);
  assertInactiveCategoryCreateCollisions(current, plan);
  assertInactiveClassificationCreateCollisions(current, plan);
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

function registerKeptCategories(ctx: RestructureExecutionContext): void {
  for (const item of ctx.plan.categoriesToKeep) {
    if (item.currentId) ctx.categoryIdByFinalName.set(item.targetName, item.currentId);
  }
  for (const item of ctx.plan.categoriesToReactivate) {
    if (item.currentId) ctx.categoryIdByFinalName.set(item.targetName, item.currentId);
  }
  for (const [name, meta] of Object.entries(ctx.plan.finalCategoryTargets)) {
    if (meta.reuseId) ctx.categoryIdByFinalName.set(name, meta.reuseId);
  }
}

async function applyCategoryReactivations(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.categoriesToReactivate) {
    if (!item.currentId) continue;
    const before = await ctx.tx.category.findUniqueOrThrow({ where: { id: item.currentId } });
    await ctx.tx.category.update({
      where: { id: item.currentId },
      data: { isActive: true },
    });
    ctx.categoryIdByFinalName.set(item.targetName, item.currentId);
    await recordItem(ctx, {
      entityType: "Category",
      action: "REACTIVATE",
      entityId: item.currentId,
      previousStateJson: { isActive: before.isActive, nameAr: before.nameAr },
      nextStateJson: { isActive: true, nameAr: item.targetName },
    });
  }
}

async function applyClassificationReactivations(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.classificationsToReactivate) {
    if (!item.currentId) continue;
    const before = await ctx.tx.classification.findUniqueOrThrow({
      where: { id: item.currentId },
    });
    await ctx.tx.classification.update({
      where: { id: item.currentId },
      data: { isActive: true },
    });
    await recordItem(ctx, {
      entityType: "Classification",
      action: "REACTIVATE",
      entityId: item.currentId,
      previousStateJson: {
        isActive: before.isActive,
        nameAr: before.nameAr,
        categoryId: before.categoryId,
      },
      nextStateJson: {
        isActive: true,
        nameAr: item.targetName,
        categoryId: before.categoryId,
      },
    });
  }
}

async function stageCategoryTemporaryNames(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.categoriesToRename) {
    if (!item.currentId) continue;
    const before = await ctx.tx.category.findUniqueOrThrow({ where: { id: item.currentId } });
    const tempName = tempCategoryName(ctx.runId, item.currentId);
    await ctx.tx.category.update({
      where: { id: item.currentId },
      data: { nameAr: tempName },
    });
    ctx.categoryIdByOriginalName.set(before.nameAr, item.currentId);
    ctx.categoryIdByTemporaryName.set(tempName, item.currentId);
  }
}

async function applyCategoryCreates(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.categoriesToCreate) {
    const created = await ctx.tx.category.create({ data: { nameAr: item.targetName } });
    ctx.categoryIdByFinalName.set(item.targetName, created.id);
    ctx.counters.createdCount += 1;
    await recordItem(ctx, {
      entityType: "Category",
      action: "CREATE",
      entityId: created.id,
      nextStateJson: { nameAr: created.nameAr, isActive: true },
    });
  }
}

async function finalizeCategoryRenames(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.categoriesToRename) {
    if (!item.currentId) continue;
    const beforeName = item.currentName;
    await ctx.tx.category.update({
      where: { id: item.currentId },
      data: { nameAr: item.targetName },
    });
    ctx.categoryIdByFinalName.set(item.targetName, item.currentId);
    ctx.counters.renamedCount += 1;
    await recordItem(ctx, {
      entityType: "Category",
      action: "RENAME",
      entityId: item.currentId,
      previousStateJson: { nameAr: beforeName },
      nextStateJson: { nameAr: item.targetName },
    });
  }
}

async function applyClassificationCreates(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of ctx.plan.classificationsToCreate) {
    const categoryId = resolveTargetCategoryId(ctx, item.targetCategory);
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
    await recordItem(ctx, {
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

  const plannedReuseId = ctx.plan.finalCategoryTargets[targetCategory]?.reuseId;
  if (plannedReuseId) {
    ctx.categoryIdByFinalName.set(targetCategory, plannedReuseId);
    return plannedReuseId;
  }

  const finalId = ctx.categoryIdByFinalName.get(targetCategory);
  if (finalId) return finalId;

  throw new TaxonomyRestructureError(
    RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID,
    `فئة الهدف غير موجودة: ${targetCategory}`
  );
}

/** Source/previous-state lookup only — never used for final targetCategory resolution. */
export function resolveOriginalCategoryId(
  ctx: Pick<
    RestructureExecutionContext,
    "categoryIdByOriginalName" | "categoryIdByTemporaryName"
  >,
  originalName: string | null | undefined
): string | undefined {
  if (!originalName) return undefined;
  return (
    ctx.categoryIdByOriginalName.get(originalName) ??
    ctx.categoryIdByTemporaryName.get(originalName)
  );
}

function classificationMutationItems(plan: RestructurePlan) {
  return [
    ...plan.classificationsToMove,
    ...plan.classificationsToRename,
    ...plan.classificationsToSplit,
  ];
}

async function stageClassificationTemporaryNames(ctx: RestructureExecutionContext): Promise<void> {
  for (const item of classificationMutationItems(ctx.plan)) {
    if (!item.currentId || ctx.processedClassificationIds.has(item.currentId)) continue;
    await ctx.tx.classification.update({
      where: { id: item.currentId },
      data: { nameAr: tempClassificationName(ctx.runId, item.currentId) },
    });
  }
}

async function applyComplaintConsistencyForMove(
  ctx: RestructureExecutionContext,
  classificationId: string,
  previousCategoryId: string,
  targetCategoryId: string
): Promise<void> {
  const affected = await ctx.tx.complaint.findMany({
    where: {
      isDeleted: false,
      classificationId,
      categoryId: { not: targetCategoryId },
    },
    select: { id: true, categoryId: true, classificationId: true },
  });
  for (const complaint of affected) {
    await ctx.tx.complaint.updateMany({
      where: {
        id: complaint.id,
        isDeleted: false,
        classificationId,
        categoryId: complaint.categoryId,
      },
      data: { categoryId: targetCategoryId },
    });
    ctx.counters.legacyComplaintConsistencyUpdateCount += 1;
    await recordItem(ctx, {
      entityType: "Complaint",
      action: "CATEGORY_CONSISTENCY",
      entityId: complaint.id,
      previousStateJson: {
        categoryId: complaint.categoryId ?? previousCategoryId,
        classificationId,
      },
      nextStateJson: {
        categoryId: targetCategoryId,
        classificationId,
      },
    });
  }
}

async function finalizeClassificationMovesAndRenames(
  ctx: RestructureExecutionContext
): Promise<void> {
  for (const item of classificationMutationItems(ctx.plan)) {
    if (!item.currentId || ctx.processedClassificationIds.has(item.currentId)) continue;
    ctx.processedClassificationIds.add(item.currentId);
    const before = await ctx.tx.classification.findUniqueOrThrow({
      where: { id: item.currentId },
    });
    const previousName = item.currentName;
    const previousCategoryId = before.categoryId;
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
    if (previousCategoryId !== targetCategoryId) {
      ctx.counters.movedCount += 1;
      await applyComplaintConsistencyForMove(
        ctx,
        item.currentId,
        previousCategoryId,
        targetCategoryId
      );
    } else {
      ctx.counters.renamedCount += 1;
    }
    if (keywords) ctx.counters.keywordChangeCount += 1;
    await recordItem(ctx, {
      entityType: "Classification",
      action: previousCategoryId !== targetCategoryId ? "MOVE_AND_RENAME" : "RENAME",
      entityId: item.currentId,
      previousStateJson: {
        nameAr: previousName,
        categoryId: previousCategoryId,
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
    const before = await ctx.tx.classification.findUniqueOrThrow({
      where: { id: target.reuseId },
    });
    await ctx.tx.classification.update({
      where: { id: target.reuseId },
      data: { keywords },
    });
    ctx.counters.keywordChangeCount += 1;
    await recordItem(ctx, {
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
    const before = await ctx.tx.classification.findUniqueOrThrow({
      where: { id: item.currentId },
    });
    if (!before.isActive) continue;
    await ctx.tx.classification.update({
      where: { id: item.currentId },
      data: { isActive: false },
    });
    ctx.counters.deactivatedCount += 1;
    await recordItem(ctx, {
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
    await recordItem(ctx, {
      entityType: "Category",
      action: "DEACTIVATE",
      entityId: item.currentId,
      previousStateJson: { isActive: true },
      nextStateJson: { isActive: false },
    });
  }
}

async function assertComplaintCategoryConsistency(ctx: RestructureExecutionContext): Promise<void> {
  const rows = await ctx.tx.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS count
    FROM "Complaint" AS complaint
    LEFT JOIN "Classification" AS classification
      ON classification.id = complaint.classificationId
    WHERE complaint.isDeleted = 0
      AND complaint.classificationId IS NOT NULL
      AND (
        classification.id IS NULL
        OR complaint.categoryId IS NULL
        OR complaint.categoryId <> classification.categoryId
      )
  `;
  const mismatched = Number(rows[0]?.count ?? 0);
  if (mismatched > 0) {
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
        categoryIdByFinalName: new Map(),
        categoryIdByOriginalName: new Map(
          input.currentCategories.map((c) => [c.nameAr, c.id])
        ),
        categoryIdByTemporaryName: new Map(),
        processedClassificationIds: new Set(),
        counters,
        itemSequence: createRestructureItemSequence(),
      };
      registerKeptCategories(ctx);
      await applyCategoryReactivations(ctx);
      await stageCategoryTemporaryNames(ctx);
      await applyCategoryCreates(ctx);
      await finalizeCategoryRenames(ctx);
      registerKeptCategories(ctx);
      await applyClassificationReactivations(ctx);
      await stageClassificationTemporaryNames(ctx);
      await applyClassificationCreates(ctx);
      await finalizeClassificationMovesAndRenames(ctx);
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
  assertPlanIsApplicable(manifest.plan);
  const current = await assertCurrentTaxonomyMatchesPreview(db, manifest);
  await assertReactivationStateMatchesPreview(db, manifest);
  assertNoRenameCollisions(current, manifest.plan);

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
