import {
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  type Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import { logger } from "@/server/logger";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import { normalizeColumnHeader } from "@/server/imports/complaint-column-schema";
import { ImportValidationError } from "@/server/imports/import-errors";
import { normalizeTextCell } from "@/server/imports/normalization";

export type ImportedDetailLinkStatus = "ALL" | "UNLINKED" | "CURRENT" | "OTHER";

export type ImportedDetailValue = {
  normalizedValue: string;
  displayValue: string;
  occurrences: number;
  linkedKeywordsCount: number;
  alreadyLinkedToCurrentClassification: boolean;
  linkedToOtherClassification: boolean;
  linkedClassificationName?: string | null;
};

export type ImportedDetailValuesResult = {
  items: ImportedDetailValue[];
  page: number;
  pageSize: number;
  total: number;
  availableTotal: number;
  diagnostics?: ImportedDetailDiagnostics;
};

export type ImportedDetailDiagnostics = {
  confirmedBatches: number;
  rowsScanned: number;
  rowsWithSourceDetail: number;
  distinctValues: number;
};

export type ImportedDetailValuesClient = Pick<
  Prisma.TransactionClient,
  "importBatch" | "importBatchRow" | "classification"
>;

type DetailAggregate = {
  occurrences: number;
  variants: Map<string, number>;
};

type ClassificationKeywordProjection = {
  id: string;
  keywords: Prisma.JsonValue | null;
};

type ImportRowProjection = {
  id: string;
  normalizedData: unknown;
};

type RawImportRowProjection = {
  id: string;
  rawData: unknown;
};

type ImportedDetailAggregation = {
  aggregates: Map<string, DetailAggregate>;
  rowsScanned: number;
  rowsWithSourceDetail: number;
};

const DETAIL_ROW_PAGE_SIZE = 500;
const ELIGIBLE_IMPORTED_DETAIL_ROWS_WHERE: Prisma.ImportBatchRowWhereInput = {
  importBatch: { status: ImportBatchStatus.CONFIRMED },
  validationStatus: {
    in: [ImportRowValidationStatus.VALID, ImportRowValidationStatus.WARNING],
  },
  action: {
    in: [
      ImportRowAction.NEW,
      ImportRowAction.UPDATE,
      ImportRowAction.NO_CHANGE,
      ImportRowAction.DUPLICATE,
    ],
  },
};
const NORMALIZED_DETAIL_HEADERS = new Set([
  normalizeColumnHeader("sourceDetail"),
  normalizeColumnHeader("source detail"),
  normalizeColumnHeader("تفصيل"),
  normalizeColumnHeader("التفصيل"),
]);

/** @deprecated استخدم normalizeClassificationKeyword من الملف المشترك. */
export {
  normalizeClassificationKeyword as normalizeImportedDetailValue,
} from "@/lib/classifications/classification-keyword-normalizer";

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function parseKeywords(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizedHeaderDetail(record: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(record)) {
    if (!NORMALIZED_DETAIL_HEADERS.has(normalizeColumnHeader(key))) continue;
    const text = normalizeTextCell(value);
    if (text) return text;
  }
  return null;
}

export function extractSourceDetail(
  normalizedData: unknown,
  rawData: unknown
): string | null {
  const normalizedValue = extractNormalizedSourceDetail(normalizedData);
  if (normalizedValue) return normalizedValue;

  const rawRecord = asJsonRecord(rawData);
  if (!rawRecord) return null;
  const directCandidates = [
    rawRecord.sourceDetail,
    rawRecord["تفصيل"],
    rawRecord["التفصيل"],
  ];
  for (const candidate of directCandidates) {
    const text = normalizeTextCell(candidate);
    if (text) return text;
  }
  return normalizedHeaderDetail(rawRecord);
}

function extractNormalizedSourceDetail(normalizedData: unknown): string | null {
  const normalizedRecord = asJsonRecord(normalizedData);
  return normalizeTextCell(normalizedRecord?.sourceDetail) ?? null;
}

function bestDisplayValue(variants: Map<string, number>): string {
  return [...variants.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ar"))[0]?.[0] ?? "";
}

function matchesLinkStatus(
  item: ImportedDetailValue,
  linkStatus: ImportedDetailLinkStatus
): boolean {
  if (linkStatus === "UNLINKED") return item.linkedKeywordsCount === 0;
  if (linkStatus === "CURRENT") return item.alreadyLinkedToCurrentClassification;
  if (linkStatus === "OTHER") return item.linkedToOtherClassification;
  return true;
}

function buildLinkedClassificationsByValue(
  classifications: readonly ClassificationKeywordProjection[]
): Map<string, Set<string>> {
  const linkedByValue = new Map<string, Set<string>>();
  for (const classification of classifications) {
    for (const keyword of parseKeywords(classification.keywords)) {
      const normalized = normalizeClassificationKeyword(keyword);
      if (!normalized) continue;
      const linkedIds = linkedByValue.get(normalized) ?? new Set<string>();
      linkedIds.add(classification.id);
      linkedByValue.set(normalized, linkedIds);
    }
  }
  return linkedByValue;
}

function appendDetailRows(
  rows: readonly ImportRowProjection[],
  rawFallbackById: ReadonlyMap<string, unknown>,
  aggregates: Map<string, DetailAggregate>
): number {
  let rowsWithSourceDetail = 0;
  for (const row of rows) {
    const displayValue = extractSourceDetail(
      row.normalizedData,
      rawFallbackById.get(row.id)
    );
    if (!displayValue) continue;
    const normalizedValue = normalizeClassificationKeyword(displayValue);
    if (!normalizedValue) continue;
    rowsWithSourceDetail += 1;

    const aggregate = aggregates.get(normalizedValue) ?? {
      occurrences: 0,
      variants: new Map<string, number>(),
    };
    aggregate.occurrences += 1;
    aggregate.variants.set(displayValue, (aggregate.variants.get(displayValue) ?? 0) + 1);
    aggregates.set(normalizedValue, aggregate);
  }
  return rowsWithSourceDetail;
}

function buildImportedDetailPageQuery(
  cursorId: string | undefined
): Prisma.ImportBatchRowFindManyArgs {
  const cursorArgs = cursorId
    ? { cursor: { id: cursorId }, skip: 1 }
    : {};
  return {
    where: ELIGIBLE_IMPORTED_DETAIL_ROWS_WHERE,
    select: { id: true, normalizedData: true },
    orderBy: { id: "asc" },
    take: DETAIL_ROW_PAGE_SIZE,
    ...cursorArgs,
  };
}

async function loadRawFallbackById(
  client: ImportedDetailValuesClient,
  rows: readonly ImportRowProjection[]
): Promise<Map<string, unknown>> {
  const missingIds = rows
    .filter((row) => !extractNormalizedSourceDetail(row.normalizedData))
    .map((row) => row.id);
  if (missingIds.length === 0) return new Map();

  const fallbackRows: RawImportRowProjection[] = await client.importBatchRow.findMany({
    where: {
      AND: [
        ELIGIBLE_IMPORTED_DETAIL_ROWS_WHERE,
        { id: { in: missingIds } },
      ],
    },
    select: { id: true, rawData: true },
  });
  return new Map(fallbackRows.map((row) => [row.id, row.rawData]));
}

async function aggregateImportedDetails(
  client: ImportedDetailValuesClient
): Promise<ImportedDetailAggregation> {
  const aggregates = new Map<string, DetailAggregate>();
  let rowsScanned = 0;
  let rowsWithSourceDetail = 0;
  let cursorId: string | undefined;
  while (true) {
    const rows: ImportRowProjection[] = await client.importBatchRow.findMany(
      buildImportedDetailPageQuery(cursorId)
    );
    if (rows.length === 0) break;

    const rawFallbackById = await loadRawFallbackById(client, rows);
    rowsScanned += rows.length;
    rowsWithSourceDetail += appendDetailRows(rows, rawFallbackById, aggregates);
    cursorId = rows.at(-1)?.id;
    if (rows.length < DETAIL_ROW_PAGE_SIZE) break;
  }
  return { aggregates, rowsScanned, rowsWithSourceDetail };
}

function warnWhenConfirmedRowsHaveNoDetails(
  confirmedBatchCount: number,
  rowsScanned: number,
  rowsWithSourceDetail: number
): void {
  if (confirmedBatchCount === 0 || rowsScanned === 0 || rowsWithSourceDetail > 0) return;
  logger.warn("Confirmed imports contain no extractable detail values", {
    confirmedBatchCount,
    rowsScanned,
  });
}

function buildImportedDetailValues(
  aggregates: ReadonlyMap<string, DetailAggregate>,
  linkedByValue: ReadonlyMap<string, Set<string>>,
  classificationId: string | undefined,
  classificationNameById: ReadonlyMap<string, string>
): ImportedDetailValue[] {
  return [...aggregates.entries()].map(([normalizedValue, aggregate]) => {
    const linkedIds = linkedByValue.get(normalizedValue) ?? new Set<string>();
    const linkedToCurrent = Boolean(classificationId && linkedIds.has(classificationId));
    const otherId = [...linkedIds].find((id) => id !== classificationId);
    return {
      normalizedValue,
      displayValue: bestDisplayValue(aggregate.variants),
      occurrences: aggregate.occurrences,
      linkedKeywordsCount: linkedIds.size,
      alreadyLinkedToCurrentClassification: linkedToCurrent,
      linkedToOtherClassification: [...linkedIds].some((id) => id !== classificationId),
      linkedClassificationName: otherId ? classificationNameById.get(otherId) ?? null : null,
    };
  });
}

function filterAndSortImportedDetailValues(
  items: readonly ImportedDetailValue[],
  search: string,
  linkStatus: ImportedDetailLinkStatus
): ImportedDetailValue[] {
  return items
    .filter((item) => !search || item.normalizedValue.includes(search))
    .filter((item) => matchesLinkStatus(item, linkStatus))
    .sort((left, right) =>
      right.occurrences - left.occurrences || left.displayValue.localeCompare(right.displayValue, "ar")
    );
}

export async function listImportedDetailValues(input: {
  search?: string;
  classificationId?: string;
  linkStatus?: ImportedDetailLinkStatus;
  page?: number;
  pageSize?: number;
} = {}, client: ImportedDetailValuesClient = db): Promise<ImportedDetailValuesResult> {
  const page = positiveInteger(input.page, 1);
  const pageSize = Math.min(100, positiveInteger(input.pageSize, 50));
  const search = normalizeClassificationKeyword(input.search ?? "");
  const linkStatus = input.linkStatus ?? "ALL";

  const [confirmedBatchCount, classifications] = await Promise.all([
    client.importBatch.count({ where: { status: ImportBatchStatus.CONFIRMED } }),
    client.classification.findMany({
      where: { isActive: true, isDeleted: false },
      select: { id: true, nameAr: true, keywords: true },
    }),
  ]);

  const classificationNameById = new Map(
    classifications.map((item) => [item.id, item.nameAr] as const)
  );
  const linkedByValue = buildLinkedClassificationsByValue(classifications);
  const { aggregates, rowsScanned, rowsWithSourceDetail } =
    await aggregateImportedDetails(client);
  const availableItems = buildImportedDetailValues(
    aggregates,
    linkedByValue,
    input.classificationId,
    classificationNameById
  );
  const allItems = filterAndSortImportedDetailValues(availableItems, search, linkStatus);

  const diagnostics: ImportedDetailDiagnostics = {
    confirmedBatches: confirmedBatchCount,
    rowsScanned,
    rowsWithSourceDetail,
    distinctValues: aggregates.size,
  };
  warnWhenConfirmedRowsHaveNoDetails(
    confirmedBatchCount,
    rowsScanned,
    rowsWithSourceDetail
  );

  const start = (page - 1) * pageSize;
  return {
    items: allItems.slice(start, start + pageSize),
    page,
    pageSize,
    total: allItems.length,
    availableTotal: availableItems.length,
    ...(process.env.NODE_ENV !== "production" ? { diagnostics } : {}),
  };
}

export async function importDetailValuesAsKeywords(input: {
  classificationId: string;
  values: unknown;
  actor?: string;
}, client: Pick<typeof db, "$transaction"> = db): Promise<{
  added: number;
  alreadyExists: number;
  conflicts: never[];
  keywords: string[];
}> {
  if (!Array.isArray(input.values)) {
    throw new ImportValidationError("INVALID_KEYWORD_VALUES", "يجب إرسال قائمة قيم صالحة", 400);
  }

  const requested = new Map<string, string>();
  for (const value of input.values) {
    const displayValue = normalizeTextCell(value);
    if (!displayValue) continue;
    const normalizedValue = normalizeClassificationKeyword(displayValue);
    if (normalizedValue && !requested.has(normalizedValue)) requested.set(normalizedValue, displayValue);
  }
  if (requested.size === 0) {
    throw new ImportValidationError("EMPTY_KEYWORD_VALUES", "اختر قيمة واحدة على الأقل", 400);
  }

  return client.$transaction(async (tx) => {
    const classifications = await tx.classification.findMany({
      where: { isActive: true, isDeleted: false },
      select: { id: true, keywords: true },
    });
    const current = classifications.find((item) => item.id === input.classificationId);
    if (!current) {
      throw new ImportValidationError("CLASSIFICATION_NOT_FOUND", "التصنيف غير موجود أو غير نشط", 404);
    }

    const conflictingValues: string[] = [];
    for (const classification of classifications) {
      if (classification.id === current.id) continue;
      const normalizedKeywords = new Set(
        parseKeywords(classification.keywords).map(normalizeClassificationKeyword)
      );
      for (const [normalizedValue, displayValue] of requested) {
        if (normalizedKeywords.has(normalizedValue)) conflictingValues.push(displayValue);
      }
    }
    if (conflictingValues.length > 0) {
      throw new ImportValidationError(
        "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION",
        "هذه الكلمة مرتبطة حاليًا بتصنيف آخر.",
        409,
        { conflicts: [...new Set(conflictingValues)] }
      );
    }

    const existing = parseKeywords(current.keywords);
    const existingNormalized = new Set(existing.map(normalizeClassificationKeyword));
    const additions = [...requested].filter(([normalizedValue]) => !existingNormalized.has(normalizedValue));
    const keywords = [...existing, ...additions.map(([, displayValue]) => displayValue)];

    if (additions.length > 0) {
      await tx.classification.update({
        where: { id: current.id },
        data: { keywords },
      });
    }
    await writeAuditLog(tx, {
      action: "CLASSIFICATION_KEYWORDS_IMPORTED",
      entityType: "Classification",
      entityId: current.id,
      actor: input.actor ?? AUDIT_ACTOR_SINGLE_ADMIN,
      metadata: {
        source: "IMPORTED_DETAIL",
        requestedCount: requested.size,
        addedCount: additions.length,
        alreadyExistsCount: requested.size - additions.length,
      },
    });

    return {
      added: additions.length,
      alreadyExists: requested.size - additions.length,
      conflicts: [],
      keywords,
    };
  });
}
