import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClassificationManagementError,
  createCategory,
  createClassification,
  normalizeAndValidateKeywords,
  normalizeStoredClassificationKeywords,
  updateCategory,
  updateClassification,
} from "./classification-management-service";

type CategoryRow = {
  id: string;
  nameAr: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  isDeleted: boolean;
};

type ClassificationRow = {
  id: string;
  categoryId: string;
  nameAr: string;
  description: string | null;
  color: string;
  keywords: string[];
  isActive: boolean;
  isDeleted: boolean;
};

type AuditRow = {
  action: string;
  entityType: string;
  entityId: string | null;
  actor: string;
  metadata?: unknown;
};

function uniqueConflict(): never {
  throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

function createMemoryClient() {
  const categories = new Map<string, CategoryRow>();
  const classifications = new Map<string, ClassificationRow>();
  const audits: AuditRow[] = [];
  let catSeq = 0;
  let clsSeq = 0;

  const tx = {
    category: {
      create: async ({ data }: { data: Partial<CategoryRow> & { nameAr: string } }) => {
        for (const row of categories.values()) {
          if (row.nameAr === data.nameAr && !row.isDeleted) uniqueConflict();
        }
        const row: CategoryRow = {
          id: data.id ?? `cat_${++catSeq}`,
          nameAr: data.nameAr,
          description: data.description ?? null,
          displayOrder: data.displayOrder ?? 0,
          isActive: data.isActive ?? true,
          isDeleted: data.isDeleted ?? false,
        };
        categories.set(row.id, row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        return (
          [...categories.values()].find((row) => {
            if (where.id && row.id !== where.id) return false;
            if (where.isDeleted === false && row.isDeleted) return false;
            if (where.isActive === true && !row.isActive) return false;
            return true;
          }) ?? null
        );
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<CategoryRow>;
      }) => {
        const row = categories.get(where.id);
        if (!row) throw new Error("missing");
        if (data.nameAr) {
          for (const other of categories.values()) {
            if (other.id !== where.id && other.nameAr === data.nameAr && !other.isDeleted) {
              uniqueConflict();
            }
          }
        }
        const next = { ...row, ...data };
        categories.set(where.id, next);
        return next;
      },
    },
    classification: {
      create: async ({
        data,
      }: {
        data: {
          categoryId: string;
          nameAr: string;
          description?: string | null;
          color?: string;
          keywords?: string[];
        };
      }) => {
        for (const row of classifications.values()) {
          if (
            row.categoryId === data.categoryId
            && row.nameAr === data.nameAr
            && !row.isDeleted
          ) {
            uniqueConflict();
          }
        }
        const row: ClassificationRow = {
          id: `cls_${++clsSeq}`,
          categoryId: data.categoryId,
          nameAr: data.nameAr,
          description: data.description ?? null,
          color: data.color ?? "#64748b",
          keywords: Array.isArray(data.keywords) ? data.keywords : [],
          isActive: true,
          isDeleted: false,
        };
        classifications.set(row.id, row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        return (
          [...classifications.values()].find((row) => {
            if (where.id && row.id !== where.id) return false;
            if (where.isDeleted === false && row.isDeleted) return false;
            if (where.isActive === true && !row.isActive) return false;
            return true;
          }) ?? null
        );
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        return [...classifications.values()].filter((row) => {
          if (where.isDeleted === false && row.isDeleted) return false;
          if (where.isActive === true && !row.isActive) return false;
          if (
            where.id
            && typeof where.id === "object"
            && where.id !== null
            && "not" in where.id
            && row.id === (where.id as { not: string }).not
          ) {
            return false;
          }
          return true;
        });
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<ClassificationRow>;
      }) => {
        const row = classifications.get(where.id);
        if (!row) throw new Error("missing");
        const next = {
          ...row,
          ...data,
          keywords: data.keywords !== undefined ? (data.keywords as string[]) : row.keywords,
        };
        classifications.set(where.id, next);
        return next;
      },
    },
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        audits.push(data);
        return data;
      },
    },
  };

  return {
    $transaction: async <T>(
      fn: (t: typeof tx) => Promise<T>,
      _options?: unknown
    ) => fn(tx),
    category: tx.category,
    classification: tx.classification,
    auditLog: tx.auditLog,
    _state: { categories, classifications, audits },
  };
}

describe("normalizeAndValidateKeywords", () => {
  it("collapses Arabic-normalized duplicates and drops empties", () => {
    const result = normalizeAndValidateKeywords(["وكالة", "  وكاله  ", "", "طلب"]);
    expect(result.displayKeywords).toEqual(["وكالة", "طلب"]);
    expect(result.byNormalized.size).toBe(2);
  });

  it("rejects non-array keywords", () => {
    expect(() => normalizeAndValidateKeywords("x")).toThrow(ClassificationManagementError);
  });
});

describe("classification management service", () => {
  let client: ReturnType<typeof createMemoryClient>;

  beforeEach(() => {
    client = createMemoryClient();
  });

  it("creates a category and writes audit", async () => {
    const category = await createCategory(
      { name: "فئة أ", description: "وصف", actor: "admin" },
      client as never
    );
    expect(category.id).toBeTruthy();
    expect(client._state.categories.size).toBe(1);
    expect(client._state.audits.some((a) => a.action === "CATEGORY_CREATED")).toBe(true);
  });

  it("updates the same category id without increasing count", async () => {
    const created = await createCategory({ name: "فئة", actor: "admin" }, client as never);
    const updated = await updateCategory(
      created.id,
      { name: "فئة محدثة", description: "جديد", actor: "admin" },
      client as never
    );
    expect(updated.id).toBe(created.id);
    expect(client._state.categories.size).toBe(1);
    expect(updated.nameAr).toBe("فئة محدثة");
    expect(client._state.audits.some((a) => a.action === "CATEGORY_UPDATED")).toBe(true);
  });

  it("creates classification with keywords and persists them", async () => {
    const category = await createCategory({ name: "فئة", actor: "admin" }, client as never);
    const classification = await createClassification(
      {
        categoryId: category.id,
        name: "تصنيف",
        keywords: ["موعد", "إنتظار"],
        actor: "admin",
      },
      client as never
    );
    expect(classification.keywords).toEqual(["موعد", "إنتظار"]);
    expect(client._state.audits.some((a) => a.action === "CLASSIFICATION_CREATED")).toBe(true);
  });

  it("rejects invalid category on create classification", async () => {
    await expect(
      createClassification(
        { categoryId: "missing", name: "تصنيف", actor: "admin" },
        client as never
      )
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND", status: 404 });
  });

  it("persists manual keywords via update", async () => {
    const category = await createCategory({ name: "فئة", actor: "admin" }, client as never);
    const classification = await createClassification(
      { categoryId: category.id, name: "تصنيف", keywords: [], actor: "admin" },
      client as never
    );
    const updated = await updateClassification(
      classification.id,
      { keywords: ["وكالة", "مراجعة"], actor: "admin" },
      client as never
    );
    expect(updated.keywords).toEqual(["وكالة", "مراجعة"]);
    expect(
      client._state.audits.some((a) => a.action === "CLASSIFICATION_KEYWORDS_UPDATED")
    ).toBe(true);
  });

  it("persists imported-value keywords through normal update", async () => {
    const category = await createCategory({ name: "فئة", actor: "admin" }, client as never);
    const classification = await createClassification(
      { categoryId: category.id, name: "تصنيف", keywords: ["قديم"], actor: "admin" },
      client as never
    );
    const updated = await updateClassification(
      classification.id,
      { keywords: ["قديم", "قيمة مستوردة"], actor: "admin" },
      client as never
    );
    expect(updated.keywords).toEqual(["قديم", "قيمة مستوردة"]);
  });

  it("rejects cross-classification keyword conflict without partial save", async () => {
    const category = await createCategory({ name: "فئة", actor: "admin" }, client as never);
    const first = await createClassification(
      { categoryId: category.id, name: "أ", keywords: ["وكالة"], actor: "admin" },
      client as never
    );
    const second = await createClassification(
      { categoryId: category.id, name: "ب", keywords: [], actor: "admin" },
      client as never
    );
    await expect(
      updateClassification(
        second.id,
        { keywords: ["وكاله", "جديد"], actor: "admin" },
        client as never
      )
    ).rejects.toMatchObject({
      code: "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION",
      status: 409,
    });
    expect(client._state.classifications.get(second.id)?.keywords).toEqual([]);
    expect(client._state.classifications.get(first.id)?.keywords).toEqual(["وكالة"]);
  });

  it("allows self keywords without conflict on same classification", async () => {
    const category = await createCategory({ name: "فئة", actor: "admin" }, client as never);
    const classification = await createClassification(
      { categoryId: category.id, name: "أ", keywords: ["وكالة", "موعد"], actor: "admin" },
      client as never
    );
    const updated = await updateClassification(
      classification.id,
      { keywords: ["وكاله", "موعد", "إضافي"], actor: "admin" },
      client as never
    );
    expect(updated.keywords).toEqual(["وكاله", "موعد", "إضافي"]);
  });

  it("excludes deleted/inactive classifications from conflict policy", async () => {
    const category = await createCategory({ name: "فئة", actor: "admin" }, client as never);
    const inactive = await createClassification(
      { categoryId: category.id, name: "قديم", keywords: ["حصرية"], actor: "admin" },
      client as never
    );
    const inactiveRow = client._state.classifications.get(inactive.id)!;
    inactiveRow.isActive = false;
    inactiveRow.isDeleted = true;

    const active = await createClassification(
      { categoryId: category.id, name: "جديد", keywords: ["حصرية"], actor: "admin" },
      client as never
    );
    expect(active.keywords).toEqual(["حصرية"]);
  });

  it("reads non-array stored keywords as empty without failing the request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const category = await createCategory({ name: "فئة", actor: "admin" }, client as never);
    const classification = await createClassification(
      { categoryId: category.id, name: "تصنيف", keywords: ["ok"], actor: "admin" },
      client as never
    );
    const row = client._state.classifications.get(classification.id)!;
    row.keywords = { broken: true } as never;

    const sibling = await createClassification(
      { categoryId: category.id, name: "آخر", keywords: ["ok"], actor: "admin" },
      client as never
    );
    expect(sibling.keywords).toEqual(["ok"]);

    const stored = normalizeStoredClassificationKeywords({ broken: true }, classification.id);
    expect(stored.displayKeywords).toEqual([]);
    warn.mockRestore();
  });

  it("uses valid strings inside a malformed stored array for conflict detection", async () => {
    const category = await createCategory({ name: "فئة", actor: "admin" }, client as never);
    const first = await createClassification(
      { categoryId: category.id, name: "أ", keywords: [], actor: "admin" },
      client as never
    );
    const row = client._state.classifications.get(first.id)!;
    row.keywords = ["وكالة", 42, { x: 1 }, "موعد"] as never;

    const second = await createClassification(
      { categoryId: category.id, name: "ب", keywords: [], actor: "admin" },
      client as never
    );
    await expect(
      updateClassification(
        second.id,
        { keywords: ["وكاله"], actor: "admin" },
        client as never
      )
    ).rejects.toMatchObject({
      code: "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION",
    });
    expect(client._state.classifications.get(second.id)?.keywords).toEqual([]);
  });

  it("updates self when previous keywords array is malformed without 400", async () => {
    const category = await createCategory({ name: "فئة", actor: "admin" }, client as never);
    const classification = await createClassification(
      { categoryId: category.id, name: "أ", keywords: [], actor: "admin" },
      client as never
    );
    client._state.classifications.get(classification.id)!.keywords = "not-array" as never;

    const updated = await updateClassification(
      classification.id,
      { keywords: ["جديد"], actor: "admin" },
      client as never
    );
    expect(updated.keywords).toEqual(["جديد"]);
  });
});
