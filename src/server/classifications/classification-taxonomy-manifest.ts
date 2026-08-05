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
import type { PrismaClient } from "@prisma/client";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import { parseClassificationKeywords } from "./classification-keywords";
import { compareCodeUnits } from "./canonical-string-order";
import {
  RESTRUCTURE_ERROR_CODES,
  TaxonomyRestructureError,
  buildConfirmationToken,
  sha256,
  stableStringify,
} from "./classification-taxonomy-proposal";

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

export type RestructureItemSequence = {
  next(): number;
};

export function createRestructureItemSequence(): RestructureItemSequence {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
  };
}

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

export type LoadedCategory = {
  id: string;
  nameAr: string;
  isActive: boolean;
  isDeleted: boolean;
  complaintCount: number;
};

export type LoadedClassification = {
  id: string;
  nameAr: string;
  categoryId: string;
  categoryName: string;
  keywords: unknown;
  isActive: boolean;
  isDeleted: boolean;
  complaintCount: number;
};

export function emptyPlan(): RestructurePlan {
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

export function countPlanChanges(plan: RestructurePlan): number {
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

export function computeTaxonomyFingerprint(
  categories: readonly Pick<LoadedCategory, "id" | "nameAr" | "isActive" | "isDeleted">[],
  classifications: readonly Pick<
    LoadedClassification,
    "id" | "nameAr" | "categoryId" | "keywords" | "isActive" | "isDeleted"
  >[]
): string {
  // Legacy ID-sorted fingerprint retained for callers that still need entity ids.
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

/**
 * Shape fingerprint for taxonomy restructure: comparable across create/reuse
 * without depending on cuid values.
 */
export function computeTaxonomyShapeFingerprint(
  categories: readonly {
    nameAr: string;
    isActive: boolean;
    isDeleted?: boolean;
  }[],
  classifications: readonly {
    nameAr: string;
    categoryName: string;
    keywords: unknown;
    isActive: boolean;
    isDeleted?: boolean;
  }[]
): string {
  const catPayload = [...categories]
    .map((c) => ({
      nameNormalized: normalizeClassificationKeyword(c.nameAr),
      isActive: c.isActive,
      isDeleted: c.isDeleted ?? false,
    }))
    .sort((a, b) => compareCodeUnits(a.nameNormalized, b.nameNormalized));

  const clsPayload = [...classifications]
    .map((c) => {
      let keywords: string[] = [];
      try {
        keywords = parseClassificationKeywords(c.keywords ?? []);
      } catch {
        keywords = [];
      }
      const normalizedKeywords = [
        ...new Set(keywords.map((k) => normalizeClassificationKeyword(k)).filter(Boolean)),
      ].sort(compareCodeUnits);
      return {
        nameNormalized: normalizeClassificationKeyword(c.nameAr),
        categoryNormalized: normalizeClassificationKeyword(c.categoryName),
        isActive: c.isActive,
        isDeleted: c.isDeleted ?? false,
        normalizedKeywords,
      };
    })
    .sort((a, b) => {
      const byCat = compareCodeUnits(a.categoryNormalized, b.categoryNormalized);
      return byCat !== 0 ? byCat : compareCodeUnits(a.nameNormalized, b.nameNormalized);
    });

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
    fingerprint: computeTaxonomyShapeFingerprint(
      loadedCats,
      loadedCls.map((c) => ({
        nameAr: c.nameAr,
        categoryName: c.categoryName,
        keywords: c.keywords,
        isActive: c.isActive,
        isDeleted: c.isDeleted,
      }))
    ),
  };
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
