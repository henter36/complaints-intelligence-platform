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
  computeTaxonomyFingerprint,
  emptyPlan,
  loadCurrentTaxonomy,
  type LoadedCategory,
  type LoadedClassification,
  type PlanChange,
  type RestructureDb,
  type RestructurePlan,
} from "./classification-taxonomy-manifest";

export type CurrentTaxonomy = Awaited<ReturnType<typeof loadCurrentTaxonomy>>;

export type RestructurePlanningContext = {
  current: CurrentTaxonomy;
  proposal: ClassificationTaxonomyProposal;
  plan: RestructurePlan;
  categoriesById: Map<string, LoadedCategory>;
  classificationsById: Map<string, LoadedClassification>;
  categoriesByNormalizedName: Map<string, LoadedCategory>;
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
    categoriesByNormalizedName: new Map(
      current.categories
        .filter((c) => c.isActive)
        .map((c) => [normalizeClassificationKeyword(c.nameAr), c])
    ),
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

function resolveExistingCategory(
  ctx: RestructurePlanningContext,
  currentId: string,
  currentName: string
): LoadedCategory | undefined {
  return (
    ctx.categoriesById.get(currentId) ??
    ctx.categoriesByNormalizedName.get(normalizeClassificationKeyword(currentName))
  );
}

function resolveExistingClassification(
  ctx: RestructurePlanningContext,
  currentId: string,
  currentName: string
): LoadedClassification | undefined {
  const byId = ctx.classificationsById.get(currentId);
  if (byId) return byId;
  const normalized = normalizeClassificationKeyword(currentName);
  for (const cls of ctx.classificationsById.values()) {
    if (cls.isActive && normalizeClassificationKeyword(cls.nameAr) === normalized) return cls;
  }
  return undefined;
}

function registerCategoryReuse(
  ctx: RestructurePlanningContext,
  targetName: string,
  categoryId: string
): void {
  ctx.categoryReuseByTargetName.set(targetName, categoryId);
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

export function processCategoryMigration(
  ctx: RestructurePlanningContext,
  mig: EntityMigration
): MigrationProcessingResult {
  const existing = resolveExistingCategory(ctx, mig.currentId, mig.currentName);
  if (!existing) {
    return { kind: "MISSING", conflict: `فئة الترحيل غير موجودة: ${mig.currentName}` };
  }
  registerCategoryReuse(ctx, mig.target, existing.id);
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
    appendCategoryKeep(ctx, change);
  } else {
    appendCategoryRename(ctx, change);
  }
  return { kind: "HANDLED" };
}

export function processClassificationMigration(
  ctx: RestructurePlanningContext,
  mig: EntityMigration
): MigrationProcessingResult {
  const resolved = resolveExistingClassification(ctx, mig.currentId, mig.currentName);
  if (!resolved) {
    return { kind: "MISSING", conflict: `تصنيف الترحيل غير موجود: ${mig.currentName}` };
  }
  const target = splitTargetPath(mig.target);
  const classificationName = target.classificationName || mig.target;
  const categoryName = target.categoryName || resolved.categoryName;
  const key = findProposedClassificationKey(ctx, categoryName, classificationName);
  registerClassificationReuse(ctx, key, resolved.id);
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
): LoadedCategory | undefined {
  return (
    (categoryId ? ctx.categoriesById.get(categoryId) : undefined) ??
    ctx.categoriesByNormalizedName.get(normalizeClassificationKeyword(catNameHint))
  );
}

function planCompositeCategorySide(
  ctx: RestructurePlanningContext,
  mig: EntityMigration,
  cat: LoadedCategory | undefined,
  targetCategoryName: string
): void {
  if (!cat) {
    ctx.plan.namingConflicts.push(`فئة مركبة غير موجودة: ${mig.currentName}`);
    return;
  }
  registerCategoryReuse(ctx, targetCategoryName, cat.id);
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
    appendCategoryKeep(ctx, change);
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

  const cls =
    (ids.classificationId ? ctx.classificationsById.get(ids.classificationId) : undefined) ??
    resolveExistingClassification(ctx, "", clsNameHint);
  if (!cls) {
    ctx.plan.namingConflicts.push(`تصنيف مركب غير موجود: ${mig.currentName}`);
    return { kind: "HANDLED" };
  }

  const key = findProposedClassificationKey(ctx, target.categoryName, target.classificationName);
  registerClassificationReuse(ctx, key, cls.id);
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
      const existing = ctx.categoriesByNormalizedName.get(
        normalizeClassificationKeyword(cat.category)
      );
      if (existing) {
        registerCategoryReuse(ctx, cat.category, existing.id);
        const alreadyTracked =
          ctx.plan.categoriesToKeep.some((x) => x.currentId === existing.id) ||
          ctx.plan.categoriesToRename.some((x) => x.currentId === existing.id);
        if (!alreadyTracked) {
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

export function ensureProposedClassifications(ctx: RestructurePlanningContext): void {
  for (const cat of ctx.proposal.proposedTaxonomy) {
    for (const cls of cat.classifications) {
      const reuseClsId = ctx.classificationReuseByKey.get(cls.classificationKey) ?? null;
      ctx.plan.finalClassificationTargets[cls.classificationKey] = {
        categoryName: cls.category,
        classificationName: cls.classification,
        reuseId: reuseClsId,
      };
      if (reuseClsId) continue;
      ctx.plan.classificationsToCreate.push(
        buildPlanChange({
          currentId: null,
          currentName: "",
          targetName: cls.classification,
          currentCategory: null,
          targetCategory: cls.category,
          action: "CREATE",
          reason: "تصنيف فرعي مقترح جديد",
          affectedExistingComplaintCount: 0,
          classificationKey: cls.classificationKey,
          keywords: cls.sourceDetails,
        })
      );
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
  targetCats: Array<{ id: string; nameAr: string; isActive: boolean; isDeleted: boolean }>;
  targetCls: Array<{
    id: string;
    nameAr: string;
    categoryId: string;
    keywords: string[];
    isActive: boolean;
    isDeleted: boolean;
  }>;
} {
  const targetCats = ctx.proposal.proposedTaxonomy.map((c, i) => ({
    id: ctx.categoryReuseByTargetName.get(c.category) ?? `new-cat-${i}`,
    nameAr: c.category,
    isActive: true,
    isDeleted: false,
  }));
  const targetCls = ctx.proposal.proposedTaxonomy.flatMap((cat, ci) =>
    cat.classifications.map((cls, i) => ({
      id: ctx.classificationReuseByKey.get(cls.classificationKey) ?? `new-cls-${ci}-${i}`,
      nameAr: cls.classification,
      categoryId: ctx.categoryReuseByTargetName.get(cls.category) ?? `new-cat-${ci}`,
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
    targetFingerprint: computeTaxonomyFingerprint(targetCats, targetCls),
  };
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
