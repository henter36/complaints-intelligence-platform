import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import { parseClassificationKeywords } from "./classification-keywords";
import {
  type ClassificationTaxonomyProposal,
  type EntityMigration,
  type ProposedClassification,
  parseDualId,
  splitTargetPath,
} from "./classification-taxonomy-proposal";
import {
  computeTaxonomyShapeFingerprint,
  emptyPlan,
  loadCurrentTaxonomy,
  type LoadedCategory,
  type LoadedClassification,
  type PlanChange,
  type RestructureDb,
  type RestructurePlan,
} from "./classification-taxonomy-manifest";
import {
  RESTRUCTURE_ERROR_CODES,
  TaxonomyRestructureError,
} from "./classification-taxonomy-proposal";

export type CurrentTaxonomy = Awaited<ReturnType<typeof loadCurrentTaxonomy>>;

export type RestructurePlanningContext = {
  current: CurrentTaxonomy;
  proposal: ClassificationTaxonomyProposal;
  plan: RestructurePlan;
  categoriesById: Map<string, LoadedCategory>;
  classificationsById: Map<string, LoadedClassification>;
  proposedClassificationsByKey: Map<string, ProposedClassification>;
  proposedKeyByCategoryAndName: Map<string, string>;
  categoryReuseByTargetName: Map<string, string>;
  classificationReuseByKey: Map<string, string>;
  classificationKeyByReuseId: Map<string, string>;
  reusedClassificationIds: Set<string>;
};

type MigrationProcessingResult =
  | { kind: "HANDLED" }
  | { kind: "MISSING"; conflict: string }
  | { kind: "IGNORED"; reason: string };

function proposedKeyLookup(categoryName: string, classificationName: string): string {
  return `${categoryName}\0${classificationName}`;
}

export function buildPlanChange(input: {
  currentId: string | null;
  currentName: string;
  targetName: string;
  currentCategory: string | null;
  targetCategory: string | null;
  action: string;
  reason: string;
  affectedExistingComplaintCount: number;
  classificationKey?: string;
  keywords?: string[];
}): PlanChange {
  return {
    currentId: input.currentId,
    currentName: input.currentName,
    targetName: input.targetName,
    currentCategory: input.currentCategory,
    targetCategory: input.targetCategory,
    action: input.action,
    reason: input.reason,
    affectedExistingComplaintCount: input.affectedExistingComplaintCount,
    ...(input.classificationKey !== undefined
      ? { classificationKey: input.classificationKey }
      : {}),
    ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
  };
}

export function createPlanningContext(
  current: CurrentTaxonomy,
  proposal: ClassificationTaxonomyProposal
): RestructurePlanningContext {
  return {
    current,
    proposal,
    plan: emptyPlan(),
    categoriesById: new Map(current.categories.map((c) => [c.id, c])),
    classificationsById: new Map(current.classifications.map((c) => [c.id, c])),
    proposedClassificationsByKey: new Map(),
    proposedKeyByCategoryAndName: new Map(),
    categoryReuseByTargetName: new Map(),
    classificationReuseByKey: new Map(),
    classificationKeyByReuseId: new Map(),
    reusedClassificationIds: new Set(),
  };
}

export function indexProposedTaxonomy(ctx: RestructurePlanningContext): void {
  for (const cat of ctx.proposal.proposedTaxonomy) {
    for (const cls of cat.classifications) {
      ctx.proposedClassificationsByKey.set(cls.classificationKey, cls);
      ctx.plan.finalKeywordsByKey[cls.classificationKey] = [...cls.sourceDetails];
      ctx.proposedKeyByCategoryAndName.set(
        proposedKeyLookup(cls.category, cls.classification),
        cls.classificationKey
      );
    }
  }
}

export function findProposedClassificationKey(
  ctx: RestructurePlanningContext,
  categoryName: string,
  classificationName: string
): string | null {
  return (
    ctx.proposedKeyByCategoryAndName.get(proposedKeyLookup(categoryName, classificationName)) ??
    null
  );
}

export type CategoryResolution =
  | { status: "FOUND"; category: LoadedCategory }
  | { status: "MISSING" }
  | { status: "AMBIGUOUS"; matches: LoadedCategory[] };

export function resolveExistingCategory(
  ctx: RestructurePlanningContext,
  currentId: string,
  currentName: string
): CategoryResolution {
  if (currentId) {
    const byId = ctx.categoriesById.get(currentId);
    if (byId && !byId.isDeleted) return { status: "FOUND", category: byId };
  }
  const live = [...ctx.categoriesById.values()].filter((c) => !c.isDeleted);
  const exact = live.filter((c) => c.nameAr === currentName);
  if (exact.length === 1) return { status: "FOUND", category: exact[0]! };
  if (exact.length > 1) return { status: "AMBIGUOUS", matches: exact };

  const normalized = normalizeClassificationKeyword(currentName);
  if (!normalized) return { status: "MISSING" };
  const matches = live.filter(
    (c) => normalizeClassificationKeyword(c.nameAr) === normalized
  );
  if (matches.length === 1) return { status: "FOUND", category: matches[0]! };
  if (matches.length === 0) return { status: "MISSING" };
  return { status: "AMBIGUOUS", matches };
}

export type ClassificationResolution =
  | { status: "FOUND"; classification: LoadedClassification }
  | { status: "MISSING" }
  | { status: "AMBIGUOUS"; matches: LoadedClassification[] };

export function resolveExistingClassification(
  ctx: RestructurePlanningContext,
  currentId: string,
  currentName: string,
  categoryHint?: string | null,
  options?: { includeInactive?: boolean }
): ClassificationResolution {
  if (currentId) {
    const byId = ctx.classificationsById.get(currentId);
    if (byId && !byId.isDeleted) return { status: "FOUND", classification: byId };
  }
  const normalized = normalizeClassificationKeyword(currentName);
  if (!normalized) return { status: "MISSING" };
  const categoryNorm = categoryHint
    ? normalizeClassificationKeyword(categoryHint)
    : null;
  const includeInactive = options?.includeInactive === true;
  const matches = [...ctx.classificationsById.values()].filter((cls) => {
    if (cls.isDeleted) return false;
    if (!includeInactive && !cls.isActive) return false;
    if (normalizeClassificationKeyword(cls.nameAr) !== normalized) return false;
    if (!categoryNorm) return true;
    return normalizeClassificationKeyword(cls.categoryName) === categoryNorm;
  });
  if (matches.length === 1) return { status: "FOUND", classification: matches[0]! };
  if (matches.length === 0) return { status: "MISSING" };
  return { status: "AMBIGUOUS", matches };
}

function resolutionConflictLabel(
  currentName: string,
  resolution: ClassificationResolution | CategoryResolution
): string {
  if (resolution.status === "MISSING") {
    return `كيان الترحيل غير موجود: ${currentName}`;
  }
  if (resolution.status === "AMBIGUOUS") {
    return `كيان الترحيل غامض بالاسم: ${currentName}`;
  }
  return currentName;
}

function registerCategoryReuse(
  ctx: RestructurePlanningContext,
  targetName: string,
  categoryId: string
): void {
  ctx.categoryReuseByTargetName.set(targetName, categoryId);
}

function ensureCategoryReactivation(
  ctx: RestructurePlanningContext,
  category: LoadedCategory,
  targetName: string
): void {
  if (category.isActive) return;
  if (ctx.plan.categoriesToReactivate.some((x) => x.currentId === category.id)) return;
  ctx.plan.categoriesToReactivate.push(
    buildPlanChange({
      currentId: category.id,
      currentName: category.nameAr,
      targetName,
      currentCategory: category.nameAr,
      targetCategory: targetName,
      action: "REACTIVATE",
      reason: "إعادة تفعيل فئة غير نشطة مطابقة",
      affectedExistingComplaintCount: category.complaintCount,
    })
  );
}

function registerClassificationReuse(
  ctx: RestructurePlanningContext,
  key: string | null,
  classificationId: string
): void {
  ctx.reusedClassificationIds.add(classificationId);
  if (!key) return;
  ctx.classificationReuseByKey.set(key, classificationId);
  ctx.classificationKeyByReuseId.set(classificationId, key);
}

function ensureClassificationReactivation(
  ctx: RestructurePlanningContext,
  classification: LoadedClassification,
  targetName: string,
  targetCategory: string,
  classificationKey?: string | null
): void {
  if (classification.isActive) return;
  if (ctx.plan.classificationsToReactivate.some((x) => x.currentId === classification.id)) {
    return;
  }
  ctx.plan.classificationsToReactivate.push(
    buildPlanChange({
      currentId: classification.id,
      currentName: classification.nameAr,
      targetName,
      currentCategory: classification.categoryName,
      targetCategory,
      action: "REACTIVATE",
      reason: "إعادة تفعيل تصنيف غير نشط مطابق",
      affectedExistingComplaintCount: classification.complaintCount,
      classificationKey: classificationKey ?? undefined,
    })
  );
}

function appendCategoryKeep(ctx: RestructurePlanningContext, change: PlanChange): void {
  ctx.plan.categoriesToKeep.push(change);
}

function appendCategoryRename(ctx: RestructurePlanningContext, change: PlanChange): void {
  ctx.plan.categoriesToRename.push(change);
}

function appendLegacyComplaintTrack(ctx: RestructurePlanningContext, change: PlanChange): void {
  if (change.affectedExistingComplaintCount <= 0) return;
  ctx.plan.legacyComplaintsAffected.push({ ...change });
}

function appendMoveComplaintTracks(ctx: RestructurePlanningContext, change: PlanChange): void {
  if (change.affectedExistingComplaintCount <= 0) return;
  ctx.plan.legacyComplaintsAffected.push({ ...change });
  ctx.plan.complaintsRequiringCategoryConsistencyUpdate.push({ ...change });
}

function appendClassificationMove(ctx: RestructurePlanningContext, change: PlanChange): void {
  ctx.plan.classificationsToMove.push(change);
  appendMoveComplaintTracks(ctx, change);
}

function appendClassificationSplit(ctx: RestructurePlanningContext, change: PlanChange): void {
  ctx.plan.classificationsToSplit.push(change);
  appendLegacyComplaintTrack(ctx, change);
}

function appendClassificationRename(ctx: RestructurePlanningContext, change: PlanChange): void {
  ctx.plan.classificationsToRename.push(change);
  appendLegacyComplaintTrack(ctx, change);
}

function categoryAlreadyTracked(ctx: RestructurePlanningContext, categoryId: string): boolean {
  return (
    ctx.plan.categoriesToKeep.some((x) => x.currentId === categoryId) ||
    ctx.plan.categoriesToRename.some((x) => x.currentId === categoryId) ||
    ctx.plan.categoriesToReactivate.some((x) => x.currentId === categoryId)
  );
}

export function processCategoryMigration(
  ctx: RestructurePlanningContext,
  mig: EntityMigration
): MigrationProcessingResult {
  const resolution = resolveExistingCategory(ctx, mig.currentId, mig.currentName);
  if (resolution.status !== "FOUND") {
    return {
      kind: "MISSING",
      conflict: resolutionConflictLabel(mig.currentName, resolution),
    };
  }
  const existing = resolution.category;
  registerCategoryReuse(ctx, mig.target, existing.id);
  ensureCategoryReactivation(ctx, existing, mig.target);
  const change = buildPlanChange({
    currentId: existing.id,
    currentName: existing.nameAr,
    targetName: mig.target,
    currentCategory: existing.nameAr,
    targetCategory: mig.target,
    action: mig.action,
    reason: mig.details,
    affectedExistingComplaintCount: existing.complaintCount,
  });
  if (mig.action === "KEEP" && existing.nameAr === mig.target) {
    if (existing.isActive) appendCategoryKeep(ctx, change);
  } else {
    appendCategoryRename(ctx, change);
  }
  return { kind: "HANDLED" };
}

export function processClassificationMigration(
  ctx: RestructurePlanningContext,
  mig: EntityMigration
): MigrationProcessingResult {
  const target = splitTargetPath(mig.target);
  const categoryHint = target.categoryName || null;
  const resolution = resolveExistingClassification(
    ctx,
    mig.currentId,
    mig.currentName,
    categoryHint
  );
  if (resolution.status !== "FOUND") {
    return {
      kind: "MISSING",
      conflict: resolutionConflictLabel(mig.currentName, resolution),
    };
  }
  const resolved = resolution.classification;
  const classificationName = target.classificationName || mig.target;
  const categoryName = target.categoryName || resolved.categoryName;
  const key = findProposedClassificationKey(ctx, categoryName, classificationName);
  registerClassificationReuse(ctx, key, resolved.id);
  ensureClassificationReactivation(ctx, resolved, classificationName, categoryName, key);
  const isMove =
    mig.action.includes("MOVE") ||
    (Boolean(target.categoryName) &&
      normalizeClassificationKeyword(target.categoryName) !==
        normalizeClassificationKeyword(resolved.categoryName));
  const change = buildPlanChange({
    currentId: resolved.id,
    currentName: resolved.nameAr,
    targetName: classificationName,
    currentCategory: resolved.categoryName,
    targetCategory: categoryName,
    action: mig.action,
    reason: mig.details,
    affectedExistingComplaintCount: resolved.complaintCount,
    classificationKey: key ?? undefined,
  });
  if (isMove) appendClassificationMove(ctx, change);
  else if (mig.action.includes("SPLIT")) appendClassificationSplit(ctx, change);
  else appendClassificationRename(ctx, change);
  return { kind: "HANDLED" };
}

function resolveCompositeCategory(
  ctx: RestructurePlanningContext,
  categoryId: string | null | undefined,
  catNameHint: string
): CategoryResolution {
  return resolveExistingCategory(ctx, categoryId ?? "", catNameHint);
}

function planCompositeCategorySide(
  ctx: RestructurePlanningContext,
  mig: EntityMigration,
  catResolution: CategoryResolution,
  targetCategoryName: string
): void {
  if (catResolution.status !== "FOUND") {
    ctx.plan.namingConflicts.push(resolutionConflictLabel(mig.currentName, catResolution));
    return;
  }
  const cat = catResolution.category;
  registerCategoryReuse(ctx, targetCategoryName, cat.id);
  ensureCategoryReactivation(ctx, cat, targetCategoryName);
  const change = buildPlanChange({
    currentId: cat.id,
    currentName: cat.nameAr,
    targetName: targetCategoryName,
    currentCategory: cat.nameAr,
    targetCategory: targetCategoryName,
    action: mig.action,
    reason: mig.details,
    affectedExistingComplaintCount: cat.complaintCount,
  });
  if (cat.nameAr === targetCategoryName) {
    if (cat.isActive) appendCategoryKeep(ctx, change);
  } else {
    appendCategoryRename(ctx, change);
  }
}

export function processCompositeMigration(
  ctx: RestructurePlanningContext,
  mig: EntityMigration
): MigrationProcessingResult {
  const ids = parseDualId(mig.currentId);
  const target = splitTargetPath(mig.target);
  const catNameHint = mig.currentName.split(" / ")[0] ?? "";
  const clsNameHint = mig.currentName.split(" / ")[1] ?? mig.currentName;
  const cat = resolveCompositeCategory(ctx, ids.categoryId, catNameHint);
  planCompositeCategorySide(ctx, mig, cat, target.categoryName);

  const byId = ids.classificationId
    ? ctx.classificationsById.get(ids.classificationId)
    : undefined;
  const resolution = byId
    ? ({ status: "FOUND", classification: byId } as const)
    : resolveExistingClassification(ctx, "", clsNameHint, catNameHint);
  if (resolution.status !== "FOUND") {
    ctx.plan.namingConflicts.push(resolutionConflictLabel(mig.currentName, resolution));
    return { kind: "HANDLED" };
  }
  const cls = resolution.classification;

  const key = findProposedClassificationKey(ctx, target.categoryName, target.classificationName);
  registerClassificationReuse(ctx, key, cls.id);
  ensureClassificationReactivation(
    ctx,
    cls,
    target.classificationName,
    target.categoryName,
    key
  );
  const moveNeeded =
    normalizeClassificationKeyword(cls.categoryName) !==
    normalizeClassificationKeyword(target.categoryName);
  const change = buildPlanChange({
    currentId: cls.id,
    currentName: cls.nameAr,
    targetName: target.classificationName,
    currentCategory: cls.categoryName,
    targetCategory: target.categoryName,
    action: mig.action,
    reason: mig.details,
    affectedExistingComplaintCount: cls.complaintCount,
    classificationKey: key ?? undefined,
  });
  if (moveNeeded) appendClassificationMove(ctx, change);
  else appendClassificationRename(ctx, change);
  return { kind: "HANDLED" };
}

export function processEntityMigrations(ctx: RestructurePlanningContext): void {
  for (const mig of ctx.proposal.currentEntityMigration) {
    let result: MigrationProcessingResult;
    if (mig.entityType === "Category") result = processCategoryMigration(ctx, mig);
    else if (mig.entityType === "Classification") result = processClassificationMigration(ctx, mig);
    else if (mig.entityType === "Category+Classification") {
      result = processCompositeMigration(ctx, mig);
    } else {
      result = { kind: "IGNORED", reason: mig.entityType };
    }
    if (result.kind === "MISSING") ctx.plan.namingConflicts.push(result.conflict);
  }
}

export function ensureProposedCategories(ctx: RestructurePlanningContext): void {
  for (const cat of ctx.proposal.proposedTaxonomy) {
    if (!ctx.categoryReuseByTargetName.has(cat.category)) {
      const resolution = resolveExistingCategory(ctx, "", cat.category);
      if (resolution.status === "AMBIGUOUS") {
        ctx.plan.namingConflicts.push(resolutionConflictLabel(cat.category, resolution));
      } else if (resolution.status === "FOUND") {
        const existing = resolution.category;
        registerCategoryReuse(ctx, cat.category, existing.id);
        ensureCategoryReactivation(ctx, existing, cat.category);
        if (existing.isActive && !categoryAlreadyTracked(ctx, existing.id)) {
          ctx.plan.categoriesToKeep.push(
            buildPlanChange({
              currentId: existing.id,
              currentName: existing.nameAr,
              targetName: cat.category,
              currentCategory: existing.nameAr,
              targetCategory: cat.category,
              action: "KEEP",
              reason: "مطابقة بالاسم",
              affectedExistingComplaintCount: existing.complaintCount,
            })
          );
        }
      } else {
        ctx.plan.categoriesToCreate.push(
          buildPlanChange({
            currentId: null,
            currentName: "",
            targetName: cat.category,
            currentCategory: null,
            targetCategory: cat.category,
            action: "CREATE",
            reason: "فئة مقترحة جديدة",
            affectedExistingComplaintCount: 0,
          })
        );
      }
    }
    ctx.plan.finalCategoryTargets[cat.category] = {
      reuseId: ctx.categoryReuseByTargetName.get(cat.category) ?? null,
    };
  }
}

function classificationAlreadyTracked(
  ctx: RestructurePlanningContext,
  classification: ProposedClassification,
  resolvedId: string
): boolean {
  return (
    ctx.plan.classificationsToKeep.some(
      (x) =>
        x.currentId === resolvedId || x.classificationKey === classification.classificationKey
    ) ||
    ctx.plan.classificationsToReactivate.some(
      (x) =>
        x.currentId === resolvedId || x.classificationKey === classification.classificationKey
    ) ||
    ctx.plan.classificationsToRename.some((x) => x.currentId === resolvedId) ||
    ctx.plan.classificationsToMove.some((x) => x.currentId === resolvedId) ||
    ctx.plan.classificationsToSplit.some((x) => x.currentId === resolvedId)
  );
}

type ProposedClassificationPlanningResult =
  | { status: "REUSED"; reuseId: string }
  | { status: "CREATE" }
  | { status: "BLOCKED" };

function appendClassificationKeepIfNeeded(
  ctx: RestructurePlanningContext,
  classification: ProposedClassification,
  resolved: LoadedClassification
): void {
  if (!resolved.isActive) return;
  if (classificationAlreadyTracked(ctx, classification, resolved.id)) return;
  ctx.plan.classificationsToKeep.push(
    buildPlanChange({
      currentId: resolved.id,
      currentName: resolved.nameAr,
      targetName: classification.classification,
      currentCategory: resolved.categoryName,
      targetCategory: classification.category,
      action: "KEEP",
      reason: "مطابقة بالاسم والفئة",
      affectedExistingComplaintCount: resolved.complaintCount,
      classificationKey: classification.classificationKey,
    })
  );
}

function handleResolvedProposedClassification(
  ctx: RestructurePlanningContext,
  classification: ProposedClassification,
  resolved: LoadedClassification
): string {
  registerClassificationReuse(ctx, classification.classificationKey, resolved.id);
  ensureClassificationReactivation(
    ctx,
    resolved,
    classification.classification,
    classification.category,
    classification.classificationKey
  );
  appendClassificationKeepIfNeeded(ctx, classification, resolved);
  return resolved.id;
}

function resolveProposedClassificationReuse(
  ctx: RestructurePlanningContext,
  classification: ProposedClassification
): ProposedClassificationPlanningResult {
  const existingReuseId = ctx.classificationReuseByKey.get(classification.classificationKey);
  if (existingReuseId) {
    return { status: "REUSED", reuseId: existingReuseId };
  }

  const resolution = resolveExistingClassification(
    ctx,
    "",
    classification.classification,
    classification.category,
    { includeInactive: true }
  );

  if (resolution.status === "AMBIGUOUS") {
    ctx.plan.namingConflicts.push(
      resolutionConflictLabel(
        `${classification.category} / ${classification.classification}`,
        resolution
      )
    );
    return { status: "BLOCKED" };
  }

  if (resolution.status === "FOUND") {
    return {
      status: "REUSED",
      reuseId: handleResolvedProposedClassification(ctx, classification, resolution.classification),
    };
  }

  return { status: "CREATE" };
}

function setFinalClassificationTarget(
  ctx: RestructurePlanningContext,
  classification: ProposedClassification,
  reuseId: string | null
): void {
  ctx.plan.finalClassificationTargets[classification.classificationKey] = {
    categoryName: classification.category,
    classificationName: classification.classification,
    reuseId,
  };
}

function appendProposedClassificationCreate(
  ctx: RestructurePlanningContext,
  classification: ProposedClassification
): void {
  ctx.plan.classificationsToCreate.push(
    buildPlanChange({
      currentId: null,
      currentName: "",
      targetName: classification.classification,
      currentCategory: null,
      targetCategory: classification.category,
      action: "CREATE",
      reason: "تصنيف فرعي مقترح جديد",
      affectedExistingComplaintCount: 0,
      classificationKey: classification.classificationKey,
      keywords: classification.sourceDetails,
    })
  );
}

function processProposedClassification(
  ctx: RestructurePlanningContext,
  classification: ProposedClassification
): void {
  const planning = resolveProposedClassificationReuse(ctx, classification);
  if (planning.status === "REUSED") {
    setFinalClassificationTarget(ctx, classification, planning.reuseId);
    return;
  }
  if (planning.status === "BLOCKED") {
    setFinalClassificationTarget(ctx, classification, null);
    return;
  }
  setFinalClassificationTarget(ctx, classification, null);
  appendProposedClassificationCreate(ctx, classification);
}

export function ensureProposedClassifications(ctx: RestructurePlanningContext): void {
  for (const category of ctx.proposal.proposedTaxonomy) {
    for (const classification of category.classifications) {
      processProposedClassification(ctx, classification);
    }
  }
}

function parseActiveClassificationKeywords(keywords: unknown): string[] {
  try {
    return parseClassificationKeywords(keywords ?? []);
  } catch {
    return [];
  }
}

function planKeywordRemovals(
  ctx: RestructurePlanningContext,
  cls: LoadedClassification,
  currentKeywords: string[],
  targetNorm: Set<string>,
  proposed: ProposedClassification | undefined
): void {
  for (const kw of currentKeywords) {
    if (targetNorm.has(normalizeClassificationKeyword(kw))) continue;
    ctx.plan.keywordsToRemove.push(
      buildPlanChange({
        currentId: cls.id,
        currentName: cls.nameAr,
        targetName: proposed?.classification ?? "",
        currentCategory: cls.categoryName,
        targetCategory: proposed?.category ?? null,
        action: "KEYWORD_REMOVE",
        reason: "إزالة كلمة",
        affectedExistingComplaintCount: 0,
        keywords: [kw],
      })
    );
  }
}

function planKeywordAdditions(
  ctx: RestructurePlanningContext,
  cls: LoadedClassification,
  targetKeywords: string[],
  currentNorm: Set<string>,
  proposed: ProposedClassification | undefined,
  reusedKey: string | undefined
): void {
  for (const kw of targetKeywords) {
    if (currentNorm.has(normalizeClassificationKeyword(kw))) continue;
    ctx.plan.keywordsToAdd.push(
      buildPlanChange({
        currentId: cls.id,
        currentName: cls.nameAr,
        targetName: proposed?.classification ?? "",
        currentCategory: cls.categoryName,
        targetCategory: proposed?.category ?? null,
        action: "KEYWORD_ADD",
        reason: "إضافة كلمة",
        affectedExistingComplaintCount: 0,
        keywords: [kw],
        classificationKey: reusedKey,
      })
    );
  }
}

export function planClassificationKeywordChanges(ctx: RestructurePlanningContext): void {
  for (const cls of ctx.current.classifications.filter((c) => c.isActive)) {
    const currentKeywords = parseActiveClassificationKeywords(cls.keywords);
    const reusedKey = ctx.classificationKeyByReuseId.get(cls.id);
    let targetKeywords = reusedKey ? ctx.plan.finalKeywordsByKey[reusedKey] : undefined;
    targetKeywords ??= [];
    const currentNorm = new Set(currentKeywords.map((k) => normalizeClassificationKeyword(k)));
    const targetNorm = new Set(targetKeywords.map((k) => normalizeClassificationKeyword(k)));
    const proposed = reusedKey ? ctx.proposedClassificationsByKey.get(reusedKey) : undefined;
    planKeywordRemovals(ctx, cls, currentKeywords, targetNorm, proposed);
    planKeywordAdditions(ctx, cls, targetKeywords, currentNorm, proposed, reusedKey);
  }
}

export function planNewClassificationKeywords(ctx: RestructurePlanningContext): void {
  for (const create of ctx.plan.classificationsToCreate) {
    if (!create.keywords?.length) continue;
    ctx.plan.keywordsToAdd.push({
      ...create,
      action: "KEYWORD_ADD",
      reason: "كلمات التصنيف الجديد",
    });
  }
}

export function planCategoryDeactivations(ctx: RestructurePlanningContext): void {
  const reused = new Set(ctx.categoryReuseByTargetName.values());
  for (const cat of ctx.current.categories.filter((c) => c.isActive)) {
    if (reused.has(cat.id)) continue;
    if (cat.complaintCount > 0) {
      ctx.plan.namingConflicts.push(
        `${RESTRUCTURE_ERROR_CODES.CATEGORY_WITH_COMPLAINTS_CANNOT_BE_DEACTIVATED}:${cat.id}`
      );
      continue;
    }
    ctx.plan.categoriesToDeactivate.push(
      buildPlanChange({
        currentId: cat.id,
        currentName: cat.nameAr,
        targetName: cat.nameAr,
        currentCategory: cat.nameAr,
        targetCategory: null,
        action: "DEACTIVATE",
        reason: "غير مستخدمة في الهيكل المقترح",
        affectedExistingComplaintCount: cat.complaintCount,
      })
    );
  }
}

export function planClassificationDeactivations(ctx: RestructurePlanningContext): void {
  for (const cls of ctx.current.classifications.filter((c) => c.isActive)) {
    if (ctx.reusedClassificationIds.has(cls.id)) continue;
    if (cls.complaintCount > 0) {
      ctx.plan.namingConflicts.push(
        `${RESTRUCTURE_ERROR_CODES.CLASSIFICATION_WITH_COMPLAINTS_CANNOT_BE_DEACTIVATED}:${cls.id}`
      );
      continue;
    }
    ctx.plan.classificationsToDeactivate.push(
      buildPlanChange({
        currentId: cls.id,
        currentName: cls.nameAr,
        targetName: cls.nameAr,
        currentCategory: cls.categoryName,
        targetCategory: null,
        action: "DEACTIVATE",
        reason: "غير مستخدم في الهيكل المقترح",
        affectedExistingComplaintCount: cls.complaintCount,
      })
    );
  }
}

export async function planComplaintConsistencyRepairs(
  ctx: RestructurePlanningContext,
  db: RestructureDb
): Promise<void> {
  const mismatched = await db.complaint.findMany({
    where: { isDeleted: false, classificationId: { not: null } },
    select: {
      id: true,
      categoryId: true,
      classification: { select: { categoryId: true, nameAr: true } },
    },
  });
  for (const c of mismatched) {
    if (!c.classification || c.categoryId === c.classification.categoryId) continue;
    ctx.plan.complaintsRequiringCategoryConsistencyUpdate.push(
      buildPlanChange({
        currentId: c.id,
        currentName: c.classification.nameAr,
        targetName: c.classification.nameAr,
        currentCategory: c.categoryId,
        targetCategory: c.classification.categoryId,
        action: "CATEGORY_CONSISTENCY",
        reason: "CATEGORY_CLASSIFICATION_MISMATCH",
        affectedExistingComplaintCount: 1,
      })
    );
  }
}

export function buildTargetTaxonomySnapshot(ctx: RestructurePlanningContext): {
  targetCats: Array<{ nameAr: string; isActive: boolean; isDeleted: boolean }>;
  targetCls: Array<{
    nameAr: string;
    categoryName: string;
    keywords: string[];
    isActive: boolean;
    isDeleted: boolean;
  }>;
} {
  const targetCats = ctx.proposal.proposedTaxonomy.map((c) => ({
    nameAr: c.category,
    isActive: true,
    isDeleted: false,
  }));
  const targetCls = ctx.proposal.proposedTaxonomy.flatMap((cat) =>
    cat.classifications.map((cls) => ({
      nameAr: cls.classification,
      categoryName: cls.category,
      keywords: cls.sourceDetails,
      isActive: true,
      isDeleted: false,
    }))
  );
  return { targetCats, targetCls };
}

export function finalizeRestructurePlan(ctx: RestructurePlanningContext): {
  plan: RestructurePlan;
  currentFingerprint: string;
  targetFingerprint: string;
} {
  const { targetCats, targetCls } = buildTargetTaxonomySnapshot(ctx);
  return {
    plan: ctx.plan,
    currentFingerprint: ctx.current.fingerprint,
    targetFingerprint: computeTaxonomyShapeFingerprint(targetCats, targetCls),
  };
}

export function assertPlanIsApplicable(plan: RestructurePlan): void {
  const blockers = [
    ...plan.namingConflicts,
    ...plan.keywordConflicts,
    ...plan.duplicateProposedKeys,
    ...plan.missingSourceDetailMappings,
  ];
  if (blockers.length === 0) return;
  throw new TaxonomyRestructureError(
    RESTRUCTURE_ERROR_CODES.PLAN_NOT_APPLICABLE,
    "الخطة تحتوي تعارضات تمنع التطبيق",
    { blockerCount: blockers.length }
  );
}

export async function buildRestructurePlan(
  db: RestructureDb,
  proposal: ClassificationTaxonomyProposal
): Promise<{ plan: RestructurePlan; currentFingerprint: string; targetFingerprint: string }> {
  const current = await loadCurrentTaxonomy(db);
  const ctx = createPlanningContext(current, proposal);
  indexProposedTaxonomy(ctx);
  processEntityMigrations(ctx);
  ensureProposedCategories(ctx);
  ensureProposedClassifications(ctx);
  planClassificationKeywordChanges(ctx);
  planNewClassificationKeywords(ctx);
  planCategoryDeactivations(ctx);
  planClassificationDeactivations(ctx);
  await planComplaintConsistencyRepairs(ctx, db);
  return finalizeRestructurePlan(ctx);
}
