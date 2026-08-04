import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import { parseClassificationKeywords } from "@/server/classifications/classification-keywords";
import { normalizeImportedDetailValue } from "@/server/classifications/imported-detail-values-service";

export type ManagementClient = Pick<
  typeof db,
  "$transaction" | "category" | "classification" | "auditLog"
>;

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

/** Shared keyword normalization for management + import resolver consistency. */
export function normalizeClassificationKeyword(value: string): string {
  return normalizeImportedDetailValue(value);
}

export type NormalizedKeywordList = {
  displayKeywords: string[];
  byNormalized: Map<string, string>;
};

/**
 * Trim, drop empties, collapse duplicates by normalized form,
 * keep first Arabic display variant for each normalized key.
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

  const byNormalized = new Map<string, string>();
  for (const item of parsed) {
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

async function findKeywordConflicts(
  client: ManagementClient | Prisma.TransactionClient,
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
    const existing = normalizeAndValidateKeywords(classification.keywords ?? []).byNormalized;
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

  return client.$transaction(async (tx) => {
    const category = await tx.category.findFirst({
      where: { id: input.categoryId, isDeleted: false, isActive: true },
      select: { id: true },
    });
    if (!category) {
      throw new ClassificationManagementError(
        "CATEGORY_NOT_FOUND",
        "الفئة المحددة غير موجودة أو غير نشطة",
        404
      );
    }

    const conflicts = await findKeywordConflicts(tx, keywordList);
    if (conflicts.length > 0) {
      throw new ClassificationManagementError(
        "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION",
        "كلمة مفتاحية واحدة أو أكثر مرتبطة بتصنيف آخر",
        409,
        { conflicts }
      );
    }

    try {
      const classification = await tx.classification.create({
        data: {
          categoryId: category.id,
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
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ClassificationManagementError(
          "CLASSIFICATION_NAME_CONFLICT",
          "اسم التصنيف مستخدم بالفعل ضمن هذه الفئة",
          409
        );
      }
      throw error;
    }
  });
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
  return client.$transaction(async (tx) => {
    const existing = await tx.classification.findFirst({
      where: { id: classificationId, isDeleted: false, isActive: true },
    });
    if (!existing) {
      throw new ClassificationManagementError(
        "CLASSIFICATION_NOT_FOUND",
        "التصنيف غير موجود أو غير نشط",
        404
      );
    }

    const nextCategoryId = input.categoryId ?? existing.categoryId;
    if (input.categoryId) {
      const category = await tx.category.findFirst({
        where: { id: input.categoryId, isDeleted: false, isActive: true },
        select: { id: true },
      });
      if (!category) {
        throw new ClassificationManagementError(
          "CATEGORY_NOT_FOUND",
          "الفئة المحددة غير موجودة أو غير نشطة",
          404
        );
      }
    }

    const name = input.name !== undefined ? input.name.trim() : existing.nameAr;
    if (!name) {
      throw new ClassificationManagementError(
        "INVALID_CLASSIFICATION_NAME",
        "اسم التصنيف مطلوب",
        400
      );
    }

    let previousKeywords: string[] = [];
    try {
      previousKeywords = parseClassificationKeywords(existing.keywords);
    } catch {
      previousKeywords = [];
    }

    const nextKeywords =
      input.keywords !== undefined
        ? normalizeAndValidateKeywords(input.keywords)
        : normalizeAndValidateKeywords(previousKeywords);

    if (input.keywords !== undefined) {
      const conflicts = await findKeywordConflicts(tx, nextKeywords, classificationId);
      if (conflicts.length > 0) {
        throw new ClassificationManagementError(
          "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION",
          "كلمة مفتاحية واحدة أو أكثر مرتبطة بتصنيف آخر",
          409,
          { conflicts }
        );
      }
    }

    try {
      const classification = await tx.classification.update({
        where: { id: classificationId },
        data: {
          categoryId: nextCategoryId,
          nameAr: name,
          ...(input.description !== undefined
            ? { description: input.description?.trim() || null }
            : {}),
          ...(input.color !== undefined
            ? { color: input.color?.trim() || existing.color }
            : {}),
          ...(input.keywords !== undefined ? { keywords: nextKeywords.displayKeywords } : {}),
        },
      });

      const categoryChanged = nextCategoryId !== existing.categoryId;
      const counts = keywordCounts(previousKeywords, nextKeywords.displayKeywords);
      await writeAuditLog(tx, {
        action: "CLASSIFICATION_UPDATED",
        entityType: "Classification",
        entityId: classification.id,
        actor: input.actor ?? AUDIT_ACTOR_SINGLE_ADMIN,
        metadata: { ...counts, categoryChanged },
      });
      if (
        input.keywords !== undefined
        && (counts.addedKeywordCount > 0 || counts.removedKeywordCount > 0)
      ) {
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
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ClassificationManagementError(
          "CLASSIFICATION_NAME_CONFLICT",
          "اسم التصنيف مستخدم بالفعل ضمن هذه الفئة",
          409
        );
      }
      throw error;
    }
  });
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
