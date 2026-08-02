import {
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  type Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/server/logger";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import { normalizeArabic } from "@/server/imports/arabic-normalize";
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

const DETAIL_ROW_PAGE_SIZE = 500;
const NORMALIZED_DETAIL_HEADERS = new Set([
  normalizeColumnHeader("sourceDetail"),
  normalizeColumnHeader("source detail"),
  normalizeColumnHeader("تفصيل"),
  normalizeColumnHeader("التفصيل"),
]);

export function normalizeImportedDetailValue(value: string): string {
  return normalizeArabic(value)
    .replaceAll(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
}

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
  const normalizedRecord = asJsonRecord(normalizedData);
  const normalizedValue = normalizeTextCell(normalizedRecord?.sourceDetail);
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

export async function listImportedDetailValues(input: {
  search?: string;
  classificationId?: string;
  linkStatus?: ImportedDetailLinkStatus;
  page?: number;
  pageSize?: number;
} = {}, client: ImportedDetailValuesClient = db): Promise<ImportedDetailValuesResult> {
  const page = positiveInteger(input.page, 1);
  const pageSize = Math.min(100, positiveInteger(input.pageSize, 50));
  const search = normalizeImportedDetailValue(input.search ?? "");
  const linkStatus = input.linkStatus ?? "ALL";

  const [confirmedBatchCount, classifications] = await Promise.all([
    client.importBatch.count({ where: { status: ImportBatchStatus.CONFIRMED } }),
    client.classification.findMany({
      where: { isActive: true, isDeleted: false },
      select: { id: true, keywords: true },
    }),
  ]);

  const linkedByValue = new Map<string, Set<string>>();
  for (const classification of classifications) {
    for (const keyword of parseKeywords(classification.keywords)) {
      const normalized = normalizeImportedDetailValue(keyword);
      if (!normalized) continue;
      const linkedIds = linkedByValue.get(normalized) ?? new Set<string>();
      linkedIds.add(classification.id);
      linkedByValue.set(normalized, linkedIds);
    }
  }

  const aggregates = new Map<string, DetailAggregate>();
  let rowsScanned = 0;
  let rowsWithSourceDetail = 0;
  let skip = 0;
  while (true) {
    const rows = await client.importBatchRow.findMany({
      where: {
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
      },
      select: { normalizedData: true, rawData: true },
      orderBy: { id: "asc" },
      skip,
      take: DETAIL_ROW_PAGE_SIZE,
    });
    rowsScanned += rows.length;
    for (const row of rows) {
      const displayValue = extractSourceDetail(row.normalizedData, row.rawData);
      if (!displayValue) continue;
      const normalizedValue = normalizeImportedDetailValue(displayValue);
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
    if (rows.length < DETAIL_ROW_PAGE_SIZE) break;
    skip += rows.length;
  }

  const availableItems = [...aggregates.entries()]
    .map(([normalizedValue, aggregate]): ImportedDetailValue => {
      const linkedIds = linkedByValue.get(normalizedValue) ?? new Set<string>();
      const linkedToCurrent = Boolean(input.classificationId && linkedIds.has(input.classificationId));
      return {
        normalizedValue,
        displayValue: bestDisplayValue(aggregate.variants),
        occurrences: aggregate.occurrences,
        linkedKeywordsCount: linkedIds.size,
        alreadyLinkedToCurrentClassification: linkedToCurrent,
        linkedToOtherClassification: [...linkedIds].some((id) => id !== input.classificationId),
      };
    });
  const allItems = availableItems
    .filter((item) => !search || item.normalizedValue.includes(search))
    .filter((item) => matchesLinkStatus(item, linkStatus))
    .sort((left, right) =>
      right.occurrences - left.occurrences || left.displayValue.localeCompare(right.displayValue, "ar")
    );

  const diagnostics: ImportedDetailDiagnostics = {
    confirmedBatches: confirmedBatchCount,
    rowsScanned,
    rowsWithSourceDetail,
    distinctValues: aggregates.size,
  };
  logger.info("Imported detail values loaded", {
    confirmedBatchCount,
    scannedRowCount: rowsScanned,
    rowsWithDetailCount: rowsWithSourceDetail,
    distinctValueCount: aggregates.size,
    filters: {
      hasSearch: Boolean(search),
      linkStatus,
      classificationContext: Boolean(input.classificationId),
      page,
      pageSize,
    },
  });

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
    const normalizedValue = normalizeImportedDetailValue(displayValue);
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
        parseKeywords(classification.keywords).map(normalizeImportedDetailValue)
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
    const existingNormalized = new Set(existing.map(normalizeImportedDetailValue));
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
