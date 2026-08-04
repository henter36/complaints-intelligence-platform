import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeClassificationKeyword as sharedNormalize } from "@/lib/classifications/classification-keyword-normalizer";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import { parseClassificationKeywords } from "@/server/classifications/classification-keywords";
import { logger } from "@/server/logger";

export type ManagementClient = Pick<
  typeof db,
  "$transaction" | "category" | "classification" | "auditLog"
>;

type TransactionClient = Parameters<Parameters<ManagementClient["$transaction"]>[0]>[0];

export type KeywordConflict = {
  keyword: string;
  classificationId: string;
  classificationName: string;
};

export class ClassificationManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Prisma.InputJsonValue
  ) {
    super(message);
    this.name = "ClassificationManagementError";
  }
}

export function toClassificationManagementErrorResponse(error: unknown):
  | { status: number; body: { error: { code: string; message: string; details?: Prisma.InputJsonValue } } }
  | null {
  if (!(error instanceof ClassificationManagementError)) return null;
  return {
    status: error.status,
    body: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
  };
}

/** Shared keyword normalization — re-export of client/server helper. */
export function normalizeClassificationKeyword(value: string): string {
  return sharedNormalize(value);
}

export type NormalizedKeywordList = {
  displayKeywords: string[];
  byNormalized: Map<string, string>;
};

/**
 * Trim, drop empties, collapse duplicates by normalized form,
 * keep first Arabic display variant for each normalized key.
 * Strict validation for user-supplied payloads.
 */
export function normalizeAndValidateKeywords(raw: unknown): NormalizedKeywordList {
  let parsed: string[];
  try {
    parsed = parseClassificationKeywords(raw ?? []);
  } catch {
    throw new ClassificationManagementError(
      "INVALID_CLASSIFICATION_KEYWORDS",
      "يجب أن تكون الكلمات المفتاحية قائمة من النصوص.",
      400
    );
  }

  return collapseKeywordDisplayForms(parsed);
}

/**
 * Tolerant reader for keywords already stored in the database.
 * Never throws INVALID_CLASSIFICATION_KEYWORDS for legacy/malformed rows.
 */
export function normalizeStoredClassificationKeywords(
  value: unknown,
  classificationId?: string
): NormalizedKeywordList {
  if (!Array.isArray(value)) {
    if (value !== null && value !== undefined && classificationId) {
      logger.warn("Stored classification keywords are not an array; treating as empty", {
        classificationId,
        invalidCount: 1,
      });
    }
    return { displayKeywords: [], byNormalized: new Map() };
  }

  const strings: string[] = [];
  let invalidCount = 0;
  for (const item of value) {
    if (typeof item === "string") {
      strings.push(item);
    } else {
      invalidCount += 1;
    }
  }
  if (invalidCount > 0 && classificationId) {
    logger.warn("Stored classification keywords contain non-string entries; ignoring them", {
      classificationId,
      invalidCount,
    });
  }

  return collapseKeywordDisplayForms(strings);
}

function collapseKeywordDisplayForms(items: string[]): NormalizedKeywordList {
  const byNormalized = new Map<string, string>();
  for (const item of items) {
    const display = item.trim();
    if (!display) continue;
    const normalized = normalizeClassificationKeyword(display);
    if (!normalized) continue;
    if (!byNormalized.has(normalized)) {
      byNormalized.set(normalized, display);
    }
  }
  return {
    displayKeywords: [...byNormalized.values()],
    byNormalized,
  };
}

function keywordCounts(previous: string[], next: string[]) {
  const prevSet = new Set(previous.map((k) => normalizeClassificationKeyword(k)));
  const nextSet = new Set(next.map((k) => normalizeClassificationKeyword(k)));
  let added = 0;
  let removed = 0;
  for (const key of nextSet) if (!prevSet.has(key)) added += 1;
  for (const key of prevSet) if (!nextSet.has(key)) removed += 1;
  return {
    previousKeywordCount: previous.length,
    newKeywordCount: next.length,
    addedKeywordCount: added,
    removedKeywordCount: removed,
  };
}

function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof ClassificationManagementError) return false;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Transient write/serialization conflict only — never retry request timeouts.
    return error.code === "P2034";
  }

  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    const message = error.message;
    return (
      message.includes("SQLITE_BUSY")
      || message.includes("database is locked")
    );
  }

  return false;
}

/** Exported for unit coverage of the concurrent keyword retry policy. */
export function isRetryableClassificationTransactionError(error: unknown): boolean {
  return isRetryableTransactionError(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Serializable transaction with bounded retry for keyword conflict safety under concurrency.
 * Domain errors are never retried; conflict checks always re-run inside a fresh transaction.
 */
export async function runSerializableClassificationMutation<T>(
  client: ManagementClient,
  operation: (tx: TransactionClient) => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await client.$transaction(
        async (tx) => operation(tx as TransactionClient),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 2_000,
          timeout: 5_000,
        }
      );
    } catch (error) {
      if (error instanceof ClassificationManagementError) throw error;
      if (!isRetryableTransactionError(error) || attempt >= maxAttempts) {
        throw error;
      }
      await sleep(Math.min(40 * attempt, 120));
    }
  }
  throw new Error("runSerializableClassificationMutation exhausted retries");
}

async function findKeywordConflicts(
  client: ManagementClient | TransactionClient | Prisma.TransactionClient,
  keywords: NormalizedKeywordList,
  excludeClassificationId?: string
): Promise<KeywordConflict[]> {
  if (keywords.byNormalized.size === 0) return [];

  const classifications = await client.classification.findMany({
    where: {
      isDeleted: false,
      isActive: true,
      ...(excludeClassificationId ? { id: { not: excludeClassificationId } } : {}),
    },
    select: { id: true, nameAr: true, keywords: true },
  });

  const conflicts: KeywordConflict[] = [];
  for (const classification of classifications) {
    const existing = normalizeStoredClassificationKeywords(
      classification.keywords,
      classification.id
    ).byNormalized;
    for (const [normalized, display] of keywords.byNormalized) {
      if (!existing.has(normalized)) continue;
      conflicts.push({
        keyword: display,
        classificationId: classification.id,
        classificationName: classification.nameAr,
      });
    }
  }
  return conflicts;
}

async function assertNoKeywordConflicts(
  client: ManagementClient | TransactionClient | Prisma.TransactionClient,
  keywords: NormalizedKeywordList,
  excludeClassificationId?: string
): Promise<void> {
  const conflicts = await findKeywordConflicts(client, keywords, excludeClassificationId);
  if (conflicts.length === 0) return;
  throw new ClassificationManagementError(
    "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION",
    "كلمة مفتاحية واحدة أو أكثر مرتبطة بتصنيف آخر",
    409,
    { conflicts }
  );
}

export async function createCategory(
  input: { name: string; description?: string | null; displayOrder?: number; actor?: string },
  client: ManagementClient = db
) {
  const name = input.name.trim();
  if (!name) {
    throw new ClassificationManagementError("INVALID_CATEGORY_NAME", "اسم الفئة مطلوب", 400);
  }

  try {
    return await client.$transaction(async (tx) => {
      const category = await tx.category.create({
        data: {
          nameAr: name,
          description: input.description?.trim() || null,
          displayOrder: input.displayOrder ?? 0,
        },
      });
      await writeAuditLog(tx, {
        action: "CATEGORY_CREATED",
        entityType: "Category",
        entityId: category.id,
        actor: input.actor ?? AUDIT_ACTOR_SINGLE_ADMIN,
        metadata: { previousKeywordCount: 0, newKeywordCount: 0 },
      });
      return category;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ClassificationManagementError(
        "CATEGORY_NAME_CONFLICT",
        "اسم الفئة مستخدم بالفعل",
        409
      );
    }
    throw error;
  }
}

export async function updateCategory(
  categoryId: string,
  input: { name?: string; description?: string | null; displayOrder?: number; actor?: string },
  client: ManagementClient = db
) {
  return client.$transaction(async (tx) => {
    const existing = await tx.category.findFirst({
      where: { id: categoryId, isDeleted: false, isActive: true },
    });
    if (!existing) {
      throw new ClassificationManagementError("CATEGORY_NOT_FOUND", "الفئة غير موجودة أو غير نشطة", 404);
    }

    const name = input.name !== undefined ? input.name.trim() : existing.nameAr;
    if (!name) {
      throw new ClassificationManagementError("INVALID_CATEGORY_NAME", "اسم الفئة مطلوب", 400);
    }

    try {
      const category = await tx.category.update({
        where: { id: categoryId },
        data: {
          nameAr: name,
          ...(input.description !== undefined
            ? { description: input.description?.trim() || null }
            : {}),
          ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        },
      });
      await writeAuditLog(tx, {
        action: "CATEGORY_UPDATED",
        entityType: "Category",
        entityId: category.id,
        actor: input.actor ?? AUDIT_ACTOR_SINGLE_ADMIN,
        metadata: {
          categoryChanged: false,
          previousKeywordCount: 0,
          newKeywordCount: 0,
          addedKeywordCount: 0,
          removedKeywordCount: 0,
        },
      });
      return category;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ClassificationManagementError(
          "CATEGORY_NAME_CONFLICT",
          "اسم الفئة مستخدم بالفعل",
          409
        );
      }
      throw error;
    }
  });
}

async function requireActiveCategory(
  client: TransactionClient | Prisma.TransactionClient,
  categoryId: string
) {
  const category = await client.category.findFirst({
    where: { id: categoryId, isDeleted: false, isActive: true },
    select: { id: true },
  });
  if (!category) {
    throw new ClassificationManagementError(
      "CATEGORY_NOT_FOUND",
      "الفئة المحددة غير موجودة أو غير نشطة",
      404
    );
  }
  return category;
}

function translateClassificationUniqueConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new ClassificationManagementError(
      "CLASSIFICATION_NAME_CONFLICT",
      "اسم التصنيف مستخدم بالفعل ضمن هذه الفئة",
      409
    );
  }
  throw error;
}

export async function createClassification(
  input: {
    categoryId: string;
    name: string;
    description?: string | null;
    color?: string | null;
    keywords?: unknown;
    actor?: string;
  },
  client: ManagementClient = db
) {
  const name = input.name.trim();
  if (!name) {
    throw new ClassificationManagementError(
      "INVALID_CLASSIFICATION_NAME",
      "اسم التصنيف مطلوب",
      400
    );
  }

  const keywordList = normalizeAndValidateKeywords(input.keywords ?? []);

  return runSerializableClassificationMutation(client, async (tx) => {
    await requireActiveCategory(tx, input.categoryId);
    await assertNoKeywordConflicts(tx, keywordList);

    try {
      const classification = await tx.classification.create({
        data: {
          categoryId: input.categoryId,
          nameAr: name,
          description: input.description?.trim() || null,
          color: input.color?.trim() || "#64748b",
          keywords: keywordList.displayKeywords,
        },
      });
      const counts = keywordCounts([], keywordList.displayKeywords);
      await writeAuditLog(tx, {
        action: "CLASSIFICATION_CREATED",
        entityType: "Classification",
        entityId: classification.id,
        actor: input.actor ?? AUDIT_ACTOR_SINGLE_ADMIN,
        metadata: { ...counts, categoryChanged: false },
      });
      if (counts.newKeywordCount > 0) {
        await writeAuditLog(tx, {
          action: "CLASSIFICATION_KEYWORDS_UPDATED",
          entityType: "Classification",
          entityId: classification.id,
          actor: input.actor ?? AUDIT_ACTOR_SINGLE_ADMIN,
          metadata: counts,
        });
      }
      return classification;
    } catch (error) {
      translateClassificationUniqueConflict(error);
    }
  });
}

async function findActiveClassificationOrThrow(
  client: TransactionClient | Prisma.TransactionClient,
  classificationId: string
) {
  const existing = await client.classification.findFirst({
    where: { id: classificationId, isDeleted: false, isActive: true },
  });
  if (!existing) {
    throw new ClassificationManagementError(
      "CLASSIFICATION_NOT_FOUND",
      "التصنيف غير موجود أو غير نشط",
      404
    );
  }
  return existing;
}

async function resolveTargetCategoryId(
  client: TransactionClient | Prisma.TransactionClient,
  existingCategoryId: string,
  requestedCategoryId?: string
): Promise<string> {
  if (!requestedCategoryId) return existingCategoryId;
  await requireActiveCategory(client, requestedCategoryId);
  return requestedCategoryId;
}

function resolveClassificationName(
  existingName: string,
  requestedName?: string
): string {
  const name = requestedName !== undefined ? requestedName.trim() : existingName;
  if (!name) {
    throw new ClassificationManagementError(
      "INVALID_CLASSIFICATION_NAME",
      "اسم التصنيف مطلوب",
      400
    );
  }
  return name;
}

function readStoredKeywordsTolerantly(
  keywords: Prisma.JsonValue | null,
  classificationId: string
): string[] {
  return normalizeStoredClassificationKeywords(keywords, classificationId).displayKeywords;
}

function resolveNextKeywordList(
  previousKeywords: string[],
  inputKeywords: unknown
): NormalizedKeywordList {
  if (inputKeywords !== undefined) {
    return normalizeAndValidateKeywords(inputKeywords);
  }
  return collapseKeywordDisplayForms(previousKeywords);
}

function buildClassificationUpdateData(
  existing: { color: string },
  input: {
    description?: string | null;
    color?: string | null;
    keywords?: unknown;
  },
  nextCategoryId: string,
  name: string,
  nextKeywords: NormalizedKeywordList
): Prisma.ClassificationUpdateInput {
  return {
    category: { connect: { id: nextCategoryId } },
    nameAr: name,
    ...(input.description !== undefined
      ? { description: input.description?.trim() || null }
      : {}),
    ...(input.color !== undefined
      ? { color: input.color?.trim() || existing.color }
      : {}),
    ...(input.keywords !== undefined ? { keywords: nextKeywords.displayKeywords } : {}),
  };
}

async function writeClassificationUpdateAudit(
  tx: TransactionClient | Prisma.TransactionClient,
  input: {
    classificationId: string;
    actor?: string;
    previousKeywords: string[];
    nextKeywords: NormalizedKeywordList;
    categoryChanged: boolean;
    keywordsChanged: boolean;
  }
) {
  const counts = keywordCounts(input.previousKeywords, input.nextKeywords.displayKeywords);
  await writeAuditLog(tx, {
    action: "CLASSIFICATION_UPDATED",
    entityType: "Classification",
    entityId: input.classificationId,
    actor: input.actor ?? AUDIT_ACTOR_SINGLE_ADMIN,
    metadata: { ...counts, categoryChanged: input.categoryChanged },
  });
  if (
    input.keywordsChanged
    && (counts.addedKeywordCount > 0 || counts.removedKeywordCount > 0)
  ) {
    await writeAuditLog(tx, {
      action: "CLASSIFICATION_KEYWORDS_UPDATED",
      entityType: "Classification",
      entityId: input.classificationId,
      actor: input.actor ?? AUDIT_ACTOR_SINGLE_ADMIN,
      metadata: counts,
    });
  }
}

export async function updateClassification(
  classificationId: string,
  input: {
    categoryId?: string;
    name?: string;
    description?: string | null;
    color?: string | null;
    keywords?: unknown;
    actor?: string;
  },
  client: ManagementClient = db
) {
  const keywordsChanged = input.keywords !== undefined;
  const run = async (tx: TransactionClient) => {
    const existing = await findActiveClassificationOrThrow(tx, classificationId);
    const nextCategoryId = await resolveTargetCategoryId(
      tx,
      existing.categoryId,
      input.categoryId
    );
    const name = resolveClassificationName(existing.nameAr, input.name);
    const previousKeywords = readStoredKeywordsTolerantly(existing.keywords, existing.id);
    const nextKeywords = resolveNextKeywordList(previousKeywords, input.keywords);

    if (keywordsChanged) {
      await assertNoKeywordConflicts(tx, nextKeywords, classificationId);
    }

    try {
      const classification = await tx.classification.update({
        where: { id: classificationId },
        data: buildClassificationUpdateData(
          existing,
          input,
          nextCategoryId,
          name,
          nextKeywords
        ),
      });

      await writeClassificationUpdateAudit(tx, {
        classificationId: classification.id,
        actor: input.actor,
        previousKeywords,
        nextKeywords,
        categoryChanged: nextCategoryId !== existing.categoryId,
        keywordsChanged,
      });
      return classification;
    } catch (error) {
      translateClassificationUniqueConflict(error);
    }
  };

  if (keywordsChanged) {
    return runSerializableClassificationMutation(client, run);
  }
  return client.$transaction(async (tx) => run(tx as TransactionClient));
}

export function mapCategoryResponse(category: {
  id: string;
  nameAr: string;
  nameEn?: string | null;
  description: string | null;
  displayOrder?: number;
}) {
  return {
    id: category.id,
    nodeType: "CATEGORY" as const,
    name: category.nameAr,
    nameEn: category.nameEn ?? null,
    description: category.description,
    parentId: null as string | null,
    displayOrder: category.displayOrder,
  };
}

export function mapClassificationResponse(classification: {
  id: string;
  nameAr: string;
  nameEn?: string | null;
  description: string | null;
  color: string;
  keywords: Prisma.JsonValue | null;
  categoryId: string;
  displayOrder?: number;
}) {
  return {
    id: classification.id,
    nodeType: "CLASSIFICATION" as const,
    name: classification.nameAr,
    nameEn: classification.nameEn ?? null,
    description: classification.description,
    color: classification.color,
    keywords: classification.keywords,
    parentId: classification.categoryId,
    displayOrder: classification.displayOrder,
  };
}
