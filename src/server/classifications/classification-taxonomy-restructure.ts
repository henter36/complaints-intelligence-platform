import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAuditLog, AUDIT_ACTOR_SYSTEM } from "@/server/audit/audit-log-service";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import { parseClassificationKeywords } from "./classification-keywords";
import {
  resolveSourceDetailClassification,
  type SourceDetailClassificationCandidate,
} from "./source-detail-classification-resolver";
import { assertClassificationNameDiffersFromCategory } from "./classification-management-service";
import { compareCodeUnits } from "./canonical-string-order";
import {
  RESTRUCTURE_ERROR_CODES,
  TaxonomyRestructureError,
  buildConfirmationToken,
  buildRollbackToken,
  loadAndValidateProposal,
  parseDualId,
  sha256,
  splitTargetPath,
  stableStringify,
  type ClassificationTaxonomyProposal,
  type ProposedClassification,
} from "./classification-taxonomy-proposal";

export * from "./classification-taxonomy-proposal";

export const RESTRUCTURE_OPERATIONS = { APPLY: "APPLY", ROLLBACK: "ROLLBACK" } as const;
export const RESTRUCTURE_RUN_STATUSES = {
  APPLYING: "APPLYING",
  APPLIED: "APPLIED",
  FAILED: "FAILED",
  VERIFY_FAILED: "VERIFY_FAILED",
  ROLLING_BACK: "ROLLING_BACK",
  ROLLED_BACK: "ROLLED_BACK",
  PARTIALLY_ROLLED_BACK: "PARTIALLY_ROLLED_BACK",
} as const;

export type RestructureDb = PrismaClient;

export type PlanChange = {
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
};

export type RestructurePlan = {
  categoriesToCreate: PlanChange[];
  categoriesToRename: PlanChange[];
  categoriesToKeep: PlanChange[];
  categoriesToDeactivate: PlanChange[];
  classificationsToCreate: PlanChange[];
  classificationsToRename: PlanChange[];
  classificationsToMove: PlanChange[];
  classificationsToSplit: PlanChange[];
  classificationsToKeep: PlanChange[];
  classificationsToDeactivate: PlanChange[];
  keywordsToAdd: PlanChange[];
  keywordsToRemove: PlanChange[];
  keywordMoves: PlanChange[];
  legacyComplaintsAffected: PlanChange[];
  complaintsRequiringCategoryConsistencyUpdate: PlanChange[];
  namingConflicts: string[];
  keywordConflicts: string[];
  duplicateProposedKeys: string[];
  missingSourceDetailMappings: string[];
  finalKeywordsByKey: Record<string, string[]>;
  finalClassificationTargets: Record<
    string,
    { categoryName: string; classificationName: string; reuseId: string | null }
  >;
  finalCategoryTargets: Record<string, { reuseId: string | null }>;
};

export type RestructureManifest = {
  schemaVersion: number;
  generatedAt: string;
  proposalHash: string;
  mappingHash: string;
  currentTaxonomyFingerprint: string;
  targetTaxonomyFingerprint: string;
  plan: RestructurePlan;
  totals: {
    changeCount: number;
    categoriesToCreate: number;
    categoriesToRename: number;
    classificationsToCreate: number;
    classificationsToRename: number;
    classificationsToMove: number;
    classificationsToDeactivate: number;
    keywordChangeCount: number;
    legacyComplaintConsistencyUpdateCount: number;
    unclassifiedComplaintsUntouched: true;
  };
  manifestHash: string;
  confirmationToken: string;
};

type LoadedCategory = {
  id: string;
  nameAr: string;
  isActive: boolean;
  isDeleted: boolean;
  complaintCount: number;
};

type LoadedClassification = {
  id: string;
  nameAr: string;
  categoryId: string;
  categoryName: string;
  keywords: unknown;
  isActive: boolean;
  isDeleted: boolean;
  complaintCount: number;
};

export function computeTaxonomyFingerprint(
  categories: readonly Pick<LoadedCategory, "id" | "nameAr" | "isActive" | "isDeleted">[],
  classifications: readonly Pick<
    LoadedClassification,
    "id" | "nameAr" | "categoryId" | "keywords" | "isActive" | "isDeleted"
  >[]
): string {
  const catPayload = [...categories]
    .map((c) => ({ id: c.id, nameAr: c.nameAr, isActive: c.isActive, isDeleted: c.isDeleted }))
    .sort((a, b) => compareCodeUnits(a.id, b.id));
  const clsPayload = [...classifications]
    .map((c) => {
      let keywords: string[] = [];
      try {
        keywords = parseClassificationKeywords(c.keywords ?? []);
      } catch {
        keywords = [];
      }
      const normalized = [
        ...new Set(keywords.map((k) => normalizeClassificationKeyword(k)).filter(Boolean)),
      ].sort(compareCodeUnits);
      return {
        id: c.id,
        nameAr: c.nameAr,
        categoryId: c.categoryId,
        isActive: c.isActive,
        isDeleted: c.isDeleted,
        normalizedKeywords: normalized,
      };
    })
    .sort((a, b) => compareCodeUnits(a.id, b.id));
  return sha256(stableStringify({ categories: catPayload, classifications: clsPayload }));
}

export async function loadCurrentTaxonomy(db: RestructureDb) {
  const categories = await db.category.findMany({
    where: { isDeleted: false },
    select: { id: true, nameAr: true, isActive: true, isDeleted: true },
    orderBy: { id: "asc" },
  });
  const classifications = await db.classification.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      nameAr: true,
      categoryId: true,
      keywords: true,
      isActive: true,
      isDeleted: true,
      category: { select: { nameAr: true } },
    },
    orderBy: { id: "asc" },
  });
  const catCounts = await db.complaint.groupBy({
    by: ["categoryId"],
    where: { isDeleted: false, categoryId: { not: null } },
    _count: { _all: true },
  });
  const clsCounts = await db.complaint.groupBy({
    by: ["classificationId"],
    where: { isDeleted: false, classificationId: { not: null } },
    _count: { _all: true },
  });
  const catCountMap = new Map(catCounts.map((c) => [c.categoryId!, c._count._all]));
  const clsCountMap = new Map(clsCounts.map((c) => [c.classificationId!, c._count._all]));

  const loadedCats: LoadedCategory[] = categories.map((c) => ({
    ...c,
    complaintCount: catCountMap.get(c.id) ?? 0,
  }));
  const loadedCls: LoadedClassification[] = classifications.map((c) => ({
    id: c.id,
    nameAr: c.nameAr,
    categoryId: c.categoryId,
    categoryName: c.category.nameAr,
    keywords: c.keywords,
    isActive: c.isActive,
    isDeleted: c.isDeleted,
    complaintCount: clsCountMap.get(c.id) ?? 0,
  }));

  return {
    categories: loadedCats,
    classifications: loadedCls,
    fingerprint: computeTaxonomyFingerprint(loadedCats, loadedCls),
  };
}

function emptyPlan(): RestructurePlan {
  return {
    categoriesToCreate: [],
    categoriesToRename: [],
    categoriesToKeep: [],
    categoriesToDeactivate: [],
    classificationsToCreate: [],
    classificationsToRename: [],
    classificationsToMove: [],
    classificationsToSplit: [],
    classificationsToKeep: [],
    classificationsToDeactivate: [],
    keywordsToAdd: [],
    keywordsToRemove: [],
    keywordMoves: [],
    legacyComplaintsAffected: [],
    complaintsRequiringCategoryConsistencyUpdate: [],
    namingConflicts: [],
    keywordConflicts: [],
    duplicateProposedKeys: [],
    missingSourceDetailMappings: [],
    finalKeywordsByKey: {},
    finalClassificationTargets: {},
    finalCategoryTargets: {},
  };
}

function countPlanChanges(plan: RestructurePlan): number {
  return (
    plan.categoriesToCreate.length +
    plan.categoriesToRename.length +
    plan.categoriesToDeactivate.length +
    plan.classificationsToCreate.length +
    plan.classificationsToRename.length +
    plan.classificationsToMove.length +
    plan.classificationsToSplit.length +
    plan.classificationsToDeactivate.length +
    plan.keywordsToAdd.length +
    plan.keywordsToRemove.length +
    plan.complaintsRequiringCategoryConsistencyUpdate.length
  );
}

export function computeManifestHash(
  manifest: Omit<RestructureManifest, "manifestHash" | "confirmationToken">
): string {
  return sha256(stableStringify(manifest));
}

export async function writeManifestAtomically(
  path: string,
  manifest: RestructureManifest,
  overwrite = false
): Promise<void> {
  const absolute = resolve(path);
  if (existsSync(absolute) && !overwrite) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.MANIFEST_EXISTS,
      "ملف manifest موجود؛ استخدم --overwrite=true"
    );
  }
  mkdirSync(dirname(absolute), { recursive: true });
  const tempPath = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  const stream = createWriteStream(tempPath, { encoding: "utf8", mode: 0o600 });
  stream.write(`${JSON.stringify(manifest, null, 2)}\n`);
  stream.end();
  await finished(stream);
  renameSync(tempPath, absolute);
  try {
    chmodSync(absolute, 0o600);
  } catch {
    // best-effort
  }
}

export async function buildRestructurePlan(
  db: RestructureDb,
  proposal: ClassificationTaxonomyProposal
): Promise<{ plan: RestructurePlan; currentFingerprint: string; targetFingerprint: string }> {
  const current = await loadCurrentTaxonomy(db);
  const catsById = new Map(current.categories.map((c) => [c.id, c]));
  const clsById = new Map(current.classifications.map((c) => [c.id, c]));
  const catsByName = new Map(
    current.categories.filter((c) => c.isActive).map((c) => [normalizeClassificationKeyword(c.nameAr), c])
  );

  const plan = emptyPlan();
  const reusedCategoryIds = new Set<string>();
  const reusedClassificationIds = new Set<string>();
  const categoryReuseByTarget = new Map<string, string>();
  const classificationReuseByKey = new Map<string, string>();

  const proposedByKey = new Map<string, ProposedClassification>();
  for (const cat of proposal.proposedTaxonomy) {
    for (const cls of cat.classifications) {
      proposedByKey.set(cls.classificationKey, cls);
      plan.finalKeywordsByKey[cls.classificationKey] = [...cls.sourceDetails];
    }
  }

  const findClsKey = (categoryName: string, classificationName: string): string | null =>
    [...proposedByKey.entries()].find(
      ([, v]) => v.classification === classificationName && v.category === categoryName
    )?.[0] ?? null;

  for (const mig of proposal.currentEntityMigration) {
    if (mig.entityType === "Category") {
      const existing =
        catsById.get(mig.currentId) ??
        catsByName.get(normalizeClassificationKeyword(mig.currentName));
      if (!existing) {
        plan.namingConflicts.push(`فئة الترحيل غير موجودة: ${mig.currentName}`);
        continue;
      }
      reusedCategoryIds.add(existing.id);
      categoryReuseByTarget.set(mig.target, existing.id);
      const change: PlanChange = {
        currentId: existing.id,
        currentName: existing.nameAr,
        targetName: mig.target,
        currentCategory: existing.nameAr,
        targetCategory: mig.target,
        action: mig.action,
        reason: mig.details,
        affectedExistingComplaintCount: existing.complaintCount,
      };
      if (mig.action === "KEEP" && existing.nameAr === mig.target) plan.categoriesToKeep.push(change);
      else plan.categoriesToRename.push(change);
      continue;
    }

    if (mig.entityType === "Classification") {
      let resolved = clsById.get(mig.currentId);
      if (!resolved) {
        resolved = [...clsById.values()].find(
          (c) =>
            c.isActive &&
            normalizeClassificationKeyword(c.nameAr) ===
              normalizeClassificationKeyword(mig.currentName)
        );
      }
      if (!resolved) {
        plan.namingConflicts.push(`تصنيف الترحيل غير موجود: ${mig.currentName}`);
        continue;
      }
      reusedClassificationIds.add(resolved.id);
      const target = splitTargetPath(mig.target);
      const classificationName = target.classificationName || mig.target;
      const categoryName = target.categoryName || resolved.categoryName;
      const key = findClsKey(categoryName, classificationName);
      if (key) classificationReuseByKey.set(key, resolved.id);
      const isMove =
        mig.action.includes("MOVE") ||
        (Boolean(target.categoryName) &&
          normalizeClassificationKeyword(target.categoryName) !==
            normalizeClassificationKeyword(resolved.categoryName));
      const change: PlanChange = {
        currentId: resolved.id,
        currentName: resolved.nameAr,
        targetName: classificationName,
        currentCategory: resolved.categoryName,
        targetCategory: categoryName,
        action: mig.action,
        reason: mig.details,
        affectedExistingComplaintCount: resolved.complaintCount,
        classificationKey: key ?? undefined,
      };
      if (isMove) {
        plan.classificationsToMove.push(change);
        if (resolved.complaintCount > 0) {
          plan.complaintsRequiringCategoryConsistencyUpdate.push({ ...change });
          plan.legacyComplaintsAffected.push({ ...change });
        }
      } else if (mig.action.includes("SPLIT")) {
        plan.classificationsToSplit.push(change);
        if (resolved.complaintCount > 0) plan.legacyComplaintsAffected.push({ ...change });
      } else {
        plan.classificationsToRename.push(change);
        if (resolved.complaintCount > 0) plan.legacyComplaintsAffected.push({ ...change });
      }
      continue;
    }

    if (mig.entityType === "Category+Classification") {
      const ids = parseDualId(mig.currentId);
      const target = splitTargetPath(mig.target);
      const cat =
        (ids.categoryId ? catsById.get(ids.categoryId) : undefined) ??
        catsByName.get(normalizeClassificationKeyword(mig.currentName.split(" / ")[0] ?? ""));
      const cls =
        (ids.classificationId ? clsById.get(ids.classificationId) : undefined) ??
        [...clsById.values()].find(
          (c) =>
            c.isActive &&
            normalizeClassificationKeyword(c.nameAr) ===
              normalizeClassificationKeyword(mig.currentName.split(" / ")[1] ?? mig.currentName)
        );
      if (cat) {
        reusedCategoryIds.add(cat.id);
        categoryReuseByTarget.set(target.categoryName, cat.id);
        const change: PlanChange = {
          currentId: cat.id,
          currentName: cat.nameAr,
          targetName: target.categoryName,
          currentCategory: cat.nameAr,
          targetCategory: target.categoryName,
          action: mig.action,
          reason: mig.details,
          affectedExistingComplaintCount: cat.complaintCount,
        };
        if (cat.nameAr !== target.categoryName) plan.categoriesToRename.push(change);
        else plan.categoriesToKeep.push({ ...change, action: "KEEP" });
      } else plan.namingConflicts.push(`فئة مركبة غير موجودة: ${mig.currentName}`);

      if (cls) {
        reusedClassificationIds.add(cls.id);
        const key = findClsKey(target.categoryName, target.classificationName);
        if (key) classificationReuseByKey.set(key, cls.id);
        const moveNeeded =
          normalizeClassificationKeyword(cls.categoryName) !==
          normalizeClassificationKeyword(target.categoryName);
        const change: PlanChange = {
          currentId: cls.id,
          currentName: cls.nameAr,
          targetName: target.classificationName,
          currentCategory: cls.categoryName,
          targetCategory: target.categoryName,
          action: mig.action,
          reason: mig.details,
          affectedExistingComplaintCount: cls.complaintCount,
          classificationKey: key ?? undefined,
        };
        if (moveNeeded) {
          plan.classificationsToMove.push(change);
          if (cls.complaintCount > 0) {
            plan.complaintsRequiringCategoryConsistencyUpdate.push({ ...change });
            plan.legacyComplaintsAffected.push({ ...change });
          }
        } else {
          plan.classificationsToRename.push(change);
          if (cls.complaintCount > 0) plan.legacyComplaintsAffected.push({ ...change });
        }
      } else plan.namingConflicts.push(`تصنيف مركب غير موجود: ${mig.currentName}`);
    }
  }

  for (const cat of proposal.proposedTaxonomy) {
    if (!categoryReuseByTarget.has(cat.category)) {
      const existing = catsByName.get(normalizeClassificationKeyword(cat.category));
      if (existing) {
        categoryReuseByTarget.set(cat.category, existing.id);
        reusedCategoryIds.add(existing.id);
        if (
          !plan.categoriesToKeep.some((x) => x.currentId === existing.id) &&
          !plan.categoriesToRename.some((x) => x.currentId === existing.id)
        ) {
          plan.categoriesToKeep.push({
            currentId: existing.id,
            currentName: existing.nameAr,
            targetName: cat.category,
            currentCategory: existing.nameAr,
            targetCategory: cat.category,
            action: "KEEP",
            reason: "مطابقة بالاسم",
            affectedExistingComplaintCount: existing.complaintCount,
          });
        }
      } else {
        plan.categoriesToCreate.push({
          currentId: null,
          currentName: "",
          targetName: cat.category,
          currentCategory: null,
          targetCategory: cat.category,
          action: "CREATE",
          reason: "فئة مقترحة جديدة",
          affectedExistingComplaintCount: 0,
        });
      }
    }
    plan.finalCategoryTargets[cat.category] = {
      reuseId: categoryReuseByTarget.get(cat.category) ?? null,
    };

    for (const cls of cat.classifications) {
      const reuseClsId = classificationReuseByKey.get(cls.classificationKey) ?? null;
      plan.finalClassificationTargets[cls.classificationKey] = {
        categoryName: cls.category,
        classificationName: cls.classification,
        reuseId: reuseClsId,
      };
      if (!reuseClsId) {
        plan.classificationsToCreate.push({
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
        });
      }
    }
  }

  for (const cls of current.classifications.filter((c) => c.isActive)) {
    let currentKeywords: string[] = [];
    try {
      currentKeywords = parseClassificationKeywords(cls.keywords ?? []);
    } catch {
      currentKeywords = [];
    }
    const reusedKey = [...classificationReuseByKey.entries()].find(([, id]) => id === cls.id)?.[0];
    const targetKeywords = reusedKey ? plan.finalKeywordsByKey[reusedKey] ?? [] : [];
    const currentNorm = new Set(currentKeywords.map((k) => normalizeClassificationKeyword(k)));
    const targetNorm = new Set(targetKeywords.map((k) => normalizeClassificationKeyword(k)));
    for (const kw of currentKeywords) {
      if (!targetNorm.has(normalizeClassificationKeyword(kw))) {
        plan.keywordsToRemove.push({
          currentId: cls.id,
          currentName: cls.nameAr,
          targetName: reusedKey ? proposedByKey.get(reusedKey)?.classification ?? "" : "",
          currentCategory: cls.categoryName,
          targetCategory: reusedKey ? proposedByKey.get(reusedKey)?.category ?? null : null,
          action: "KEYWORD_REMOVE",
          reason: "إزالة كلمة",
          affectedExistingComplaintCount: 0,
          keywords: [kw],
        });
      }
    }
    for (const kw of targetKeywords) {
      if (!currentNorm.has(normalizeClassificationKeyword(kw))) {
        plan.keywordsToAdd.push({
          currentId: cls.id,
          currentName: cls.nameAr,
          targetName: reusedKey ? proposedByKey.get(reusedKey)?.classification ?? "" : "",
          currentCategory: cls.categoryName,
          targetCategory: reusedKey ? proposedByKey.get(reusedKey)?.category ?? null : null,
          action: "KEYWORD_ADD",
          reason: "إضافة كلمة",
          affectedExistingComplaintCount: 0,
          keywords: [kw],
          classificationKey: reusedKey,
        });
      }
    }
  }
  for (const create of plan.classificationsToCreate) {
    if (create.keywords?.length) {
      plan.keywordsToAdd.push({ ...create, action: "KEYWORD_ADD", reason: "كلمات التصنيف الجديد" });
    }
  }

  for (const cat of current.categories.filter((c) => c.isActive)) {
    if (![...categoryReuseByTarget.values()].includes(cat.id)) {
      plan.categoriesToDeactivate.push({
        currentId: cat.id,
        currentName: cat.nameAr,
        targetName: cat.nameAr,
        currentCategory: cat.nameAr,
        targetCategory: null,
        action: "DEACTIVATE",
        reason: "غير مستخدمة في الهيكل المقترح",
        affectedExistingComplaintCount: cat.complaintCount,
      });
    }
  }
  for (const cls of current.classifications.filter((c) => c.isActive)) {
    if (!reusedClassificationIds.has(cls.id)) {
      plan.classificationsToDeactivate.push({
        currentId: cls.id,
        currentName: cls.nameAr,
        targetName: cls.nameAr,
        currentCategory: cls.categoryName,
        targetCategory: null,
        action: "DEACTIVATE",
        reason: "غير مستخدم في الهيكل المقترح",
        affectedExistingComplaintCount: cls.complaintCount,
      });
    }
  }

  const mismatched = await db.complaint.findMany({
    where: { isDeleted: false, classificationId: { not: null } },
    select: {
      id: true,
      categoryId: true,
      classification: { select: { categoryId: true, nameAr: true } },
    },
  });
  for (const c of mismatched) {
    if (c.classification && c.categoryId !== c.classification.categoryId) {
      plan.complaintsRequiringCategoryConsistencyUpdate.push({
        currentId: c.id,
        currentName: c.classification.nameAr,
        targetName: c.classification.nameAr,
        currentCategory: c.categoryId,
        targetCategory: c.classification.categoryId,
        action: "CATEGORY_CONSISTENCY",
        reason: "CATEGORY_CLASSIFICATION_MISMATCH",
        affectedExistingComplaintCount: 1,
      });
    }
  }

  const targetCats = proposal.proposedTaxonomy.map((c, i) => ({
    id: categoryReuseByTarget.get(c.category) ?? `new-cat-${i}`,
    nameAr: c.category,
    isActive: true,
    isDeleted: false,
  }));
  const targetCls = proposal.proposedTaxonomy.flatMap((cat, ci) =>
    cat.classifications.map((cls, i) => ({
      id: classificationReuseByKey.get(cls.classificationKey) ?? `new-cls-${ci}-${i}`,
      nameAr: cls.classification,
      categoryId: categoryReuseByTarget.get(cls.category) ?? `new-cat-${ci}`,
      keywords: cls.sourceDetails,
      isActive: true,
      isDeleted: false,
    }))
  );

  return {
    plan,
    currentFingerprint: current.fingerprint,
    targetFingerprint: computeTaxonomyFingerprint(targetCats, targetCls),
  };
}

export async function previewTaxonomyRestructure(
  db: RestructureDb,
  input: {
    proposalPath: string;
    mappingPath: string;
    manifestPath: string;
    overwrite?: boolean;
  }
) {
  const { proposal, proposalHash, mappingHash } = loadAndValidateProposal(
    input.proposalPath,
    input.mappingPath
  );
  const { plan, currentFingerprint, targetFingerprint } = await buildRestructurePlan(db, proposal);
  const changeCount = countPlanChanges(plan);
  const withoutHash: Omit<RestructureManifest, "manifestHash" | "confirmationToken"> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    proposalHash,
    mappingHash,
    currentTaxonomyFingerprint: currentFingerprint,
    targetTaxonomyFingerprint: targetFingerprint,
    plan,
    totals: {
      changeCount,
      categoriesToCreate: plan.categoriesToCreate.length,
      categoriesToRename: plan.categoriesToRename.length,
      classificationsToCreate: plan.classificationsToCreate.length,
      classificationsToRename: plan.classificationsToRename.length,
      classificationsToMove: plan.classificationsToMove.length,
      classificationsToDeactivate: plan.classificationsToDeactivate.length,
      keywordChangeCount: plan.keywordsToAdd.length + plan.keywordsToRemove.length,
      legacyComplaintConsistencyUpdateCount:
        plan.complaintsRequiringCategoryConsistencyUpdate.length,
      unclassifiedComplaintsUntouched: true,
    },
  };
  const manifestHash = computeManifestHash(withoutHash);
  const confirmationToken = buildConfirmationToken(manifestHash, changeCount);
  const manifest: RestructureManifest = { ...withoutHash, manifestHash, confirmationToken };
  await writeManifestAtomically(input.manifestPath, manifest, input.overwrite === true);
  return {
    mode: "dry-run" as const,
    manifestPath: resolve(input.manifestPath),
    manifestHash,
    currentTaxonomyFingerprint: currentFingerprint,
    targetTaxonomyFingerprint: targetFingerprint,
    confirmationToken,
    plan,
    planSummary: {
      categoriesToCreate: plan.categoriesToCreate.map((c) => c.targetName),
      categoriesToRename: plan.categoriesToRename.map((c) => `${c.currentName} → ${c.targetName}`),
      classificationsToCreate: plan.classificationsToCreate.map(
        (c) => `${c.targetCategory} / ${c.targetName}`
      ),
      classificationsToMove: plan.classificationsToMove.map(
        (c) => `${c.currentCategory}/${c.currentName} → ${c.targetCategory}/${c.targetName}`
      ),
      classificationsToRename: plan.classificationsToRename.map(
        (c) => `${c.currentName} → ${c.targetName}`
      ),
      keywordChanges: plan.keywordsToAdd.length + plan.keywordsToRemove.length,
      legacyComplaintsAffected: plan.legacyComplaintsAffected.length,
      consistencyUpdates: plan.complaintsRequiringCategoryConsistencyUpdate.length,
      namingConflicts: plan.namingConflicts,
      deactivations: {
        categories: plan.categoriesToDeactivate.map((c) => c.currentName),
        classifications: plan.classificationsToDeactivate.map((c) => c.currentName),
      },
    },
    totals: withoutHash.totals,
  };
}

export function readAndValidateManifest(path: string): RestructureManifest {
  if (!path) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.MANIFEST_REQUIRED, "manifest مطلوب");
  }
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.MANIFEST_NOT_FOUND, "ملف manifest غير موجود");
  }
  const manifest = JSON.parse(readFileSync(absolute, "utf8")) as RestructureManifest;
  if (manifest.schemaVersion !== 1) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.MANIFEST_INVALID, "إصدار manifest غير مدعوم");
  }
  const { manifestHash, confirmationToken, ...rest } = manifest;
  if (computeManifestHash(rest) !== manifestHash) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.MANIFEST_HASH_MISMATCH, "بصمة manifest غير متطابقة");
  }
  if (confirmationToken !== buildConfirmationToken(manifestHash, rest.totals.changeCount)) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.MANIFEST_INVALID, "رمز التأكيد غير متسق");
  }
  return manifest;
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
) {
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

export async function applyTaxonomyRestructure(
  db: RestructureDb,
  input: { manifestPath: string; confirm?: string; actor?: string }
) {
  if (!input.confirm) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.CONFIRMATION_REQUIRED, "رمز التأكيد مطلوب");
  }
  const actor = input.actor ?? AUDIT_ACTOR_SYSTEM;
  const manifest = readAndValidateManifest(input.manifestPath);
  if (input.confirm !== manifest.confirmationToken) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.CONFIRMATION_INVALID, "رمز التأكيد غير صحيح");
  }

  const current = await loadCurrentTaxonomy(db);
  if (current.fingerprint !== manifest.currentTaxonomyFingerprint) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.CLASSIFICATION_TAXONOMY_CHANGED_AFTER_PREVIEW,
      "تغير القاموس الحالي بعد المعاينة"
    );
  }

  const plan = manifest.plan;
  const run = await db.classificationTaxonomyRestructureRun.create({
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

  await writeAuditLog(db, {
    action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_STARTED",
    entityType: "ClassificationTaxonomyRestructureRun",
    entityId: run.id,
    actor,
    metadata: { runId: run.id, manifestHash: manifest.manifestHash, changeCount: manifest.totals.changeCount },
  });

  let createdCount = 0;
  let renamedCount = 0;
  let movedCount = 0;
  let deactivatedCount = 0;
  let keywordChangeCount = 0;
  let legacyComplaintConsistencyUpdateCount = 0;

  try {
    await db.$transaction(async (tx) => {
      const categoryIdByName = new Map<string, string>();
      for (const c of current.categories) categoryIdByName.set(c.nameAr, c.id);

      for (const item of plan.categoriesToCreate) {
        const created = await tx.category.create({ data: { nameAr: item.targetName } });
        categoryIdByName.set(item.targetName, created.id);
        createdCount += 1;
        await recordItem(tx, run.id, {
          entityType: "Category",
          action: "CREATE",
          entityId: created.id,
          nextStateJson: { nameAr: created.nameAr, isActive: true },
        });
      }

      for (const item of plan.categoriesToRename) {
        if (!item.currentId) continue;
        const before = await tx.category.findUniqueOrThrow({ where: { id: item.currentId } });
        await tx.category.update({ where: { id: item.currentId }, data: { nameAr: item.targetName } });
        categoryIdByName.delete(before.nameAr);
        categoryIdByName.set(item.targetName, item.currentId);
        renamedCount += 1;
        await recordItem(tx, run.id, {
          entityType: "Category",
          action: "RENAME",
          entityId: item.currentId,
          previousStateJson: { nameAr: before.nameAr },
          nextStateJson: { nameAr: item.targetName },
        });
      }

      for (const item of plan.categoriesToKeep) {
        if (item.currentId) categoryIdByName.set(item.targetName, item.currentId);
      }
      for (const [name, meta] of Object.entries(plan.finalCategoryTargets)) {
        if (meta.reuseId) categoryIdByName.set(name, meta.reuseId);
      }

      for (const item of plan.classificationsToCreate) {
        const categoryId = categoryIdByName.get(item.targetCategory ?? "");
        if (!categoryId) {
          throw new TaxonomyRestructureError(
            RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID,
            `فئة مفقودة لإنشاء التصنيف ${item.targetName}`
          );
        }
        assertClassificationNameDiffersFromCategory(item.targetCategory ?? "", item.targetName);
        const keywords =
          (item.classificationKey && plan.finalKeywordsByKey[item.classificationKey]) ||
          item.keywords ||
          [];
        const created = await tx.classification.create({
          data: { categoryId, nameAr: item.targetName, keywords },
        });
        createdCount += 1;
        keywordChangeCount += keywords.length > 0 ? 1 : 0;
        await recordItem(tx, run.id, {
          entityType: "Classification",
          action: "CREATE",
          entityId: created.id,
          nextStateJson: { nameAr: created.nameAr, categoryId, keywords, classificationKey: item.classificationKey },
        });
      }

      const resolveTargetCategoryId = (targetCategory: string | null): string => {
        if (!targetCategory) {
          throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID, "فئة هدف مفقودة");
        }
        const id = categoryIdByName.get(targetCategory);
        if (!id) {
          throw new TaxonomyRestructureError(
            RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID,
            `فئة الهدف غير موجودة: ${targetCategory}`
          );
        }
        return id;
      };

      const renameOrMove = [
        ...plan.classificationsToMove,
        ...plan.classificationsToRename,
        ...plan.classificationsToSplit,
      ];
      const seen = new Set<string>();
      for (const item of renameOrMove) {
        if (!item.currentId || seen.has(item.currentId)) continue;
        seen.add(item.currentId);
        const before = await tx.classification.findUniqueOrThrow({ where: { id: item.currentId } });
        const targetCategoryId = resolveTargetCategoryId(item.targetCategory);
        assertClassificationNameDiffersFromCategory(item.targetCategory ?? "", item.targetName);
        const keywords =
          item.classificationKey && plan.finalKeywordsByKey[item.classificationKey]
            ? plan.finalKeywordsByKey[item.classificationKey]
            : undefined;
        await tx.classification.update({
          where: { id: item.currentId },
          data: {
            nameAr: item.targetName,
            categoryId: targetCategoryId,
            ...(keywords ? { keywords } : {}),
          },
        });
        if (before.categoryId !== targetCategoryId) {
          movedCount += 1;
          const updated = await tx.complaint.updateMany({
            where: { isDeleted: false, classificationId: item.currentId },
            data: { categoryId: targetCategoryId },
          });
          legacyComplaintConsistencyUpdateCount += updated.count;
          await recordItem(tx, run.id, {
            entityType: "Complaint",
            action: "CATEGORY_CONSISTENCY",
            entityId: item.currentId,
            previousStateJson: { categoryId: before.categoryId },
            nextStateJson: { categoryId: targetCategoryId, updatedCount: updated.count },
          });
        } else renamedCount += 1;
        if (keywords) keywordChangeCount += 1;
        await recordItem(tx, run.id, {
          entityType: "Classification",
          action: before.categoryId !== targetCategoryId ? "MOVE_AND_RENAME" : "RENAME",
          entityId: item.currentId,
          previousStateJson: { nameAr: before.nameAr, categoryId: before.categoryId, keywords: before.keywords as Prisma.InputJsonValue },
          nextStateJson: { nameAr: item.targetName, categoryId: targetCategoryId, keywords: (keywords ?? before.keywords) as Prisma.InputJsonValue },
        });
      }

      for (const [key, keywords] of Object.entries(plan.finalKeywordsByKey)) {
        const target = plan.finalClassificationTargets[key];
        if (!target?.reuseId || seen.has(target.reuseId)) continue;
        const before = await tx.classification.findUniqueOrThrow({ where: { id: target.reuseId } });
        await tx.classification.update({ where: { id: target.reuseId }, data: { keywords } });
        keywordChangeCount += 1;
        await recordItem(tx, run.id, {
          entityType: "Classification",
          action: "KEYWORDS",
          entityId: target.reuseId,
          previousStateJson: { keywords: before.keywords as Prisma.InputJsonValue },
          nextStateJson: { keywords },
        });
      }

      for (const item of plan.classificationsToDeactivate) {
        if (!item.currentId) continue;
        const before = await tx.classification.findUniqueOrThrow({ where: { id: item.currentId } });
        if (!before.isActive) continue;
        await tx.classification.update({ where: { id: item.currentId }, data: { isActive: false } });
        deactivatedCount += 1;
        await recordItem(tx, run.id, {
          entityType: "Classification",
          action: "DEACTIVATE",
          entityId: item.currentId,
          previousStateJson: { isActive: true },
          nextStateJson: { isActive: false },
        });
      }
      for (const item of plan.categoriesToDeactivate) {
        if (!item.currentId) continue;
        const before = await tx.category.findUniqueOrThrow({ where: { id: item.currentId } });
        if (!before.isActive) continue;
        await tx.category.update({ where: { id: item.currentId }, data: { isActive: false } });
        deactivatedCount += 1;
        await recordItem(tx, run.id, {
          entityType: "Category",
          action: "DEACTIVATE",
          entityId: item.currentId,
          previousStateJson: { isActive: true },
          nextStateJson: { isActive: false },
        });
      }

      const bad = await tx.complaint.findMany({
        where: { isDeleted: false, classificationId: { not: null } },
        select: { categoryId: true, classification: { select: { categoryId: true } } },
      });
      for (const c of bad) {
        if (!c.classification || c.categoryId !== c.classification.categoryId) {
          throw new TaxonomyRestructureError(
            RESTRUCTURE_ERROR_CODES.CATEGORY_CLASSIFICATION_MISMATCH,
            "اختلاف categoryId عن classification.categoryId بعد التطبيق"
          );
        }
      }
    }, { timeout: 180_000 });

    await db.classificationTaxonomyRestructureRun.update({
      where: { id: run.id },
      data: {
        status: RESTRUCTURE_RUN_STATUSES.APPLIED,
        completedAt: new Date(),
        createdCount,
        renamedCount,
        movedCount,
        deactivatedCount,
        keywordChangeCount,
        legacyComplaintConsistencyUpdateCount,
      },
    });
    await writeAuditLog(db, {
      action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_APPLIED",
      entityType: "ClassificationTaxonomyRestructureRun",
      entityId: run.id,
      actor,
      metadata: {
        runId: run.id,
        createdCount,
        renamedCount,
        movedCount,
        deactivatedCount,
        keywordChangeCount,
        legacyComplaintConsistencyUpdateCount,
      },
    });

    return {
      mode: "apply" as const,
      runId: run.id,
      status: RESTRUCTURE_RUN_STATUSES.APPLIED,
      createdCount,
      renamedCount,
      movedCount,
      deactivatedCount,
      keywordChangeCount,
      legacyComplaintConsistencyUpdateCount,
      rollbackToken: buildRollbackToken(
        run.id,
        manifest.manifestHash,
        createdCount + renamedCount + movedCount
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "UNEXPECTED_ERROR";
    const code = error instanceof TaxonomyRestructureError ? error.code : "APPLY_FAILED";
    await db.classificationTaxonomyRestructureRun.update({
      where: { id: run.id },
      data: {
        status: RESTRUCTURE_RUN_STATUSES.FAILED,
        completedAt: new Date(),
        failureCode: code,
        failureMessage: message,
        createdCount,
        renamedCount,
        movedCount,
        deactivatedCount,
        keywordChangeCount,
        legacyComplaintConsistencyUpdateCount,
      },
    });
    await writeAuditLog(db, {
      action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_FAILED",
      entityType: "ClassificationTaxonomyRestructureRun",
      entityId: run.id,
      actor,
      metadata: { runId: run.id, failureCode: code },
    });
    throw error;
  }
}

export async function verifyTaxonomyRestructure(
  db: RestructureDb,
  input: { runId: string; proposalPath?: string; mappingPath?: string }
) {
  const run = await db.classificationTaxonomyRestructureRun.findUnique({ where: { id: input.runId } });
  if (!run) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.RUN_NOT_FOUND, "التشغيل غير موجود");
  }

  const invariants: Array<{ code: string; ok: boolean; detail?: string }> = [];
  const activeCategories = await db.category.findMany({ where: { isActive: true, isDeleted: false } });
  const activeClassifications = await db.classification.findMany({
    where: { isActive: true, isDeleted: false },
    include: { category: true },
  });

  let expectedCategoryCount = 11;
  let expectedClassificationCount = 27;
  let proposal: ClassificationTaxonomyProposal | null = null;
  if (input.proposalPath && input.mappingPath) {
    proposal = loadAndValidateProposal(input.proposalPath, input.mappingPath).proposal;
    expectedCategoryCount = proposal.proposedTaxonomy.length;
    expectedClassificationCount = proposal.proposedTaxonomy.reduce(
      (sum, cat) => sum + cat.classifications.length,
      0
    );
  }

  invariants.push({
    code: "ACTIVE_CATEGORY_COUNT",
    ok: activeCategories.length >= expectedCategoryCount,
    detail: String(activeCategories.length),
  });
  invariants.push({
    code: "ACTIVE_CLASSIFICATION_COUNT",
    ok: activeClassifications.length >= expectedClassificationCount,
    detail: String(activeClassifications.length),
  });

  let namingOk = true;
  for (const cls of activeClassifications) {
    try {
      assertClassificationNameDiffersFromCategory(cls.category.nameAr, cls.nameAr);
    } catch {
      namingOk = false;
      break;
    }
  }
  invariants.push({ code: "NO_NAME_EQUALS_CATEGORY", ok: namingOk });

  const keywordOwner = new Map<string, string>();
  let keywordOk = true;
  for (const cls of activeClassifications) {
    let kws: string[] = [];
    try {
      kws = parseClassificationKeywords(cls.keywords ?? []);
    } catch {
      kws = [];
    }
    for (const kw of kws) {
      const n = normalizeClassificationKeyword(kw);
      if (!n) continue;
      if (keywordOwner.has(n) && keywordOwner.get(n) !== cls.id) keywordOk = false;
      keywordOwner.set(n, cls.id);
    }
  }
  invariants.push({ code: "UNIQUE_KEYWORDS", ok: keywordOk });

  if (proposal) {
    const candidates: SourceDetailClassificationCandidate[] = activeClassifications.map((c) => ({
      id: c.id,
      nameAr: c.nameAr,
      keywords: c.keywords,
      isActive: c.isActive,
      isDeleted: c.isDeleted,
      category: {
        id: c.category.id,
        nameAr: c.category.nameAr,
        isActive: c.category.isActive,
        isDeleted: c.category.isDeleted,
      },
    }));
    let matched = 0;
    let ambiguous = 0;
    let unmatched = 0;
    for (const m of proposal.sourceDetailMappings) {
      const res = resolveSourceDetailClassification({
        sourceDetail: m.sourceDetail,
        classifications: candidates,
      });
      if (res.status === "MATCHED") matched += 1;
      else if (res.status === "AMBIGUOUS") ambiguous += 1;
      else unmatched += 1;
    }
    invariants.push({
      code: "SOURCE_DETAIL_MATCHED_UNIQUE",
      ok: matched === proposal.sourceDetailMappings.length && ambiguous === 0 && unmatched === 0,
      detail: `matched=${matched},ambiguous=${ambiguous},unmatched=${unmatched}`,
    });
  }

  const classified = await db.complaint.findMany({
    where: { isDeleted: false, classificationId: { not: null } },
    select: { categoryId: true, classification: { select: { categoryId: true } } },
  });
  invariants.push({
    code: "CATEGORY_CLASSIFICATION_CONSISTENCY",
    ok: classified.every((c) => c.classification && c.categoryId === c.classification.categoryId),
    detail: String(classified.length),
  });

  const unclassified = await db.complaint.count({
    where: { isDeleted: false, classificationId: null },
  });
  invariants.push({ code: "UNCLASSIFIED_PRESENT", ok: true, detail: String(unclassified) });

  const ok = invariants.every((i) => i.ok);
  if (!ok) {
    await db.classificationTaxonomyRestructureRun.update({
      where: { id: run.id },
      data: { status: RESTRUCTURE_RUN_STATUSES.VERIFY_FAILED },
    });
  }
  await writeAuditLog(db, {
    action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_VERIFIED",
    entityType: "ClassificationTaxonomyRestructureRun",
    entityId: run.id,
    actor: AUDIT_ACTOR_SYSTEM,
    metadata: { runId: run.id, ok },
  });

  return {
    mode: "verify" as const,
    runId: run.id,
    ok,
    invariants,
    activeCategoryCount: activeCategories.length,
    activeClassificationCount: activeClassifications.length,
    unclassifiedCount: unclassified,
    classifiedCount: classified.length,
  };
}

export async function rollbackTaxonomyRestructure(
  db: RestructureDb,
  input: { runId: string; confirm?: string; actor?: string }
) {
  if (!input.confirm) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.CONFIRMATION_REQUIRED, "رمز تأكيد التراجع مطلوب");
  }
  const actor = input.actor ?? AUDIT_ACTOR_SYSTEM;
  const original = await db.classificationTaxonomyRestructureRun.findUnique({ where: { id: input.runId } });
  if (!original) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.RUN_NOT_FOUND, "التشغيل غير موجود");
  }
  const appliedOps = original.createdCount + original.renamedCount + original.movedCount;
  const expected = buildRollbackToken(original.id, original.manifestHash, appliedOps);
  if (input.confirm !== expected) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.CONFIRMATION_INVALID, "رمز تأكيد التراجع غير صحيح");
  }

  const rollbackRun = await db.classificationTaxonomyRestructureRun.create({
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

  const items = await db.classificationTaxonomyRestructureItem.findMany({
    where: { runId: original.id, result: "APPLIED" },
    orderBy: { createdAt: "desc" },
  });

  let rolledBack = 0;
  let skipped = 0;
  await db.$transaction(async (tx) => {
    for (const item of items) {
      const prev = item.previousStateJson as Record<string, unknown> | null;
      if (item.action === "CREATE" && item.entityId) {
        if (item.entityType === "Classification") {
          await tx.classification.update({ where: { id: item.entityId }, data: { isActive: false } });
        } else if (item.entityType === "Category") {
          await tx.category.update({ where: { id: item.entityId }, data: { isActive: false } });
        }
        rolledBack += 1;
        continue;
      }
      if (item.action === "DEACTIVATE" && item.entityId) {
        if (item.entityType === "Classification") {
          await tx.classification.update({ where: { id: item.entityId }, data: { isActive: true } });
        } else if (item.entityType === "Category") {
          await tx.category.update({ where: { id: item.entityId }, data: { isActive: true } });
        }
        rolledBack += 1;
        continue;
      }
      if ((item.action === "RENAME" || item.action === "MOVE_AND_RENAME" || item.action === "KEYWORDS") && item.entityId && prev) {
        if (item.entityType === "Category" && typeof prev.nameAr === "string") {
          await tx.category.update({ where: { id: item.entityId }, data: { nameAr: prev.nameAr } });
          rolledBack += 1;
        } else if (item.entityType === "Classification") {
          await tx.classification.update({
            where: { id: item.entityId },
            data: {
              ...(typeof prev.nameAr === "string" ? { nameAr: prev.nameAr } : {}),
              ...(typeof prev.categoryId === "string" ? { categoryId: prev.categoryId } : {}),
              ...(prev.keywords !== undefined ? { keywords: prev.keywords as Prisma.InputJsonValue } : {}),
            },
          });
          rolledBack += 1;
        } else skipped += 1;
        continue;
      }
      if (item.action === "CATEGORY_CONSISTENCY" && item.entityId && prev && typeof prev.categoryId === "string") {
        await tx.complaint.updateMany({
          where: { classificationId: item.entityId, isDeleted: false },
          data: { categoryId: prev.categoryId },
        });
        rolledBack += 1;
        continue;
      }
      skipped += 1;
    }
  }, { timeout: 180_000 });

  const status =
    skipped > 0 ? RESTRUCTURE_RUN_STATUSES.PARTIALLY_ROLLED_BACK : RESTRUCTURE_RUN_STATUSES.ROLLED_BACK;
  await db.classificationTaxonomyRestructureRun.update({
    where: { id: rollbackRun.id },
    data: { status, completedAt: new Date(), createdCount: rolledBack, renamedCount: skipped },
  });
  await db.classificationTaxonomyRestructureRun.update({ where: { id: original.id }, data: { status } });
  await writeAuditLog(db, {
    action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_ROLLED_BACK",
    entityType: "ClassificationTaxonomyRestructureRun",
    entityId: rollbackRun.id,
    actor,
    metadata: { runId: rollbackRun.id, originalRunId: original.id, rolledBack, skipped },
  });

  return {
    mode: "rollback" as const,
    runId: rollbackRun.id,
    originalRunId: original.id,
    status,
    rolledBack,
    skipped,
  };
}
