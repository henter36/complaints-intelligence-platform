import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ClassificationSemanticCatalog } from "./llm-classification-contract";
import { retrieveClassificationCandidates } from "./classification-semantic-catalog";
import { sanitizeComplaintForClassification } from "./llm-classification-service";

export type GoldSetSplit = "DEVELOPMENT" | "HOLDOUT";
export type HumanReviewStatus = "PENDING" | "REVIEWED" | "EXCLUDED";

export type GoldSetReviewItem = {
  reviewId: string;
  split: GoldSetSplit;
  sanitizedSourceDetail: string;
  sanitizedSubject: string;
  sanitizedDescription: string;
  currentCategoryId: string | null;
  currentCategoryName: string | null;
  currentClassificationId: string | null;
  currentClassificationName: string | null;
  availableClassificationChoices: Array<{
    classificationId: string;
    classificationName: string;
    categoryId: string;
    categoryName: string;
  }>;
  humanExpectedClassificationId: string | null;
  humanReviewStatus: HumanReviewStatus;
};

export type GoldSetReviewArtifact = {
  schemaVersion: 1;
  status: "NOT_YET_LABELED" | "PARTIALLY_LABELED" | "LABELED";
  generatedAt: string;
  taxonomyFingerprint: string;
  semanticCatalogFingerprint: string;
  requestedSize: number;
  selectedCount: number;
  developmentCount: number;
  holdoutCount: number;
  items: GoldSetReviewItem[];
};

export type PrivateGoldMap = {
  schemaVersion: 1;
  generatedAt: string;
  mappings: Array<{ reviewId: string; complaintId: string }>;
};

type GoldComplaint = Awaited<ReturnType<typeof loadGoldComplaintPool>>[number];

async function loadGoldComplaintPool(db: PrismaClient) {
  return db.complaint.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      sourceDetail: true,
      subject: true,
      description: true,
      classificationId: true,
      categoryId: true,
      classification: { select: { nameAr: true } },
      category: { select: { nameAr: true } },
    },
    orderBy: { id: "asc" },
  });
}

function deterministicRank(id: string): string {
  return createHash("sha256").update(`llm-gold-v1:${id}`, "utf8").digest("hex");
}

function descriptionBand(length: number): "SHORT" | "MEDIUM" | "LONG" {
  if (length < 80) return "SHORT";
  if (length > 500) return "LONG";
  return "MEDIUM";
}

function strataFor(complaint: GoldComplaint): string[] {
  const descriptionLength = complaint.description?.length ?? 0;
  return [
    `classification:${complaint.classificationId ?? "UNCLASSIFIED"}`,
    `category:${complaint.categoryId ?? "UNCATEGORIZED"}`,
    `source:${complaint.sourceDetail?.trim() ? "PRESENT" : "ABSENT"}`,
    `description:${descriptionBand(descriptionLength)}`,
    `assignment:${complaint.classificationId && complaint.categoryId ? "COMPLETE" : "INCOMPLETE"}`,
  ];
}

function groupByStrata<T extends GoldComplaint>(ranked: readonly T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const complaint of ranked) {
    for (const stratum of strataFor(complaint)) {
      const group = groups.get(stratum) ?? [];
      group.push(complaint);
      groups.set(stratum, group);
    }
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
}

function selectRoundRobin<T extends GoldComplaint>(
  groups: ReadonlyArray<readonly [string, T[]]>,
  requestedSize: number
): Map<string, T> {
  const selected = new Map<string, T>();
  let depth = 0;
  while (selected.size < requestedSize) {
    let added = false;
    for (const [, group] of groups) {
      const candidate = group[depth];
      if (candidate && !selected.has(candidate.id)) {
        selected.set(candidate.id, candidate);
        added = true;
        if (selected.size >= requestedSize) break;
      }
    }
    if (!added) break;
    depth += 1;
  }
  return selected;
}

function fillSelection<T extends GoldComplaint>(
  selected: Map<string, T>,
  ranked: readonly T[],
  requestedSize: number
): void {
  if (selected.size >= requestedSize) return;
  for (const complaint of ranked) {
    selected.set(complaint.id, complaint);
    if (selected.size >= requestedSize) break;
  }
}

export function selectStratifiedComplaints<T extends GoldComplaint>(
  complaints: readonly T[],
  requestedSize: number
): T[] {
  if (!Number.isInteger(requestedSize) || requestedSize < 1) {
    throw new Error("GOLD_SET_SIZE_INVALID");
  }
  const ranked = [...complaints].sort((left, right) =>
    deterministicRank(left.id).localeCompare(deterministicRank(right.id), "en")
  );
  const selected = selectRoundRobin(groupByStrata(ranked), requestedSize);
  fillSelection(selected, ranked, requestedSize);
  return [...selected.values()];
}

function splitForComplaint(id: string): GoldSetSplit {
  const bucket = Number.parseInt(deterministicRank(id).slice(0, 8), 16) % 10;
  return bucket < 7 ? "DEVELOPMENT" : "HOLDOUT";
}

export async function prepareClassificationGoldSet(input: {
  db: PrismaClient;
  catalog: ClassificationSemanticCatalog;
  size: number;
  generatedAt?: Date;
}): Promise<{ review: GoldSetReviewArtifact; privateMap: PrivateGoldMap }> {
  const pool = await loadGoldComplaintPool(input.db);
  const selected = selectStratifiedComplaints(pool, Math.min(input.size, pool.length));
  const items: GoldSetReviewItem[] = [];
  const mappings: PrivateGoldMap["mappings"] = [];

  selected.forEach((complaint, index) => {
    const reviewId = `G${String(index + 1).padStart(6, "0")}`;
    const sanitized = sanitizeComplaintForClassification(complaint, index + 1);
    const candidates = retrieveClassificationCandidates({
      catalog: input.catalog,
      complaint: sanitized,
      currentClassificationId: complaint.classificationId,
    });
    items.push({
      reviewId,
      split: splitForComplaint(complaint.id),
      sanitizedSourceDetail: sanitized.sourceDetail,
      sanitizedSubject: sanitized.subject,
      sanitizedDescription: sanitized.description,
      currentCategoryId: complaint.categoryId,
      currentCategoryName: complaint.category?.nameAr ?? null,
      currentClassificationId: complaint.classificationId,
      currentClassificationName: complaint.classification?.nameAr ?? null,
      availableClassificationChoices: candidates.map((entry) => ({
        classificationId: entry.classificationId,
        classificationName: entry.classificationName,
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
      })),
      humanExpectedClassificationId: null,
      humanReviewStatus: "PENDING",
    });
    mappings.push({ reviewId, complaintId: complaint.id });
  });
  const generatedAt = (input.generatedAt ?? new Date()).toISOString();
  const developmentCount = items.filter((item) => item.split === "DEVELOPMENT").length;
  return {
    review: {
      schemaVersion: 1,
      status: "NOT_YET_LABELED",
      generatedAt,
      taxonomyFingerprint: input.catalog.taxonomyFingerprint,
      semanticCatalogFingerprint: input.catalog.semanticCatalogFingerprint,
      requestedSize: input.size,
      selectedCount: items.length,
      developmentCount,
      holdoutCount: items.length - developmentCount,
      items,
    },
    privateMap: { schemaVersion: 1, generatedAt, mappings },
  };
}

export function reviewedGoldItems(artifact: GoldSetReviewArtifact): GoldSetReviewItem[] {
  return artifact.items.filter(
    (item) => item.humanReviewStatus === "REVIEWED" && item.humanExpectedClassificationId !== null
  );
}
