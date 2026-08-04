import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ClassificationManagementError,
  createCategory,
  createClassification,
  updateCategory,
  updateClassification,
} from "./classification-management-service";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";

let prisma: PrismaClient | undefined;
let tempDir: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  tempDir = mkdtempSync(join(tmpdir(), "cip-classification-mgmt-"));
  const dbPath = join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: "pipe",
  });
  prisma = new PrismaClient();
}, 30_000);

afterAll(async () => {
  try {
    if (prisma) {
      await prisma.$disconnect();
    }
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

function client(): PrismaClient {
  if (!prisma) throw new Error("Prisma not initialized");
  return prisma;
}

describe("classification management SQLite integration", () => {
  it("creates, updates, audits, and rejects keyword conflicts", async () => {
    const db = client();
    const category = await createCategory(
      { name: `فئة-تكامل-${crypto.randomUUID().slice(0, 8)}`, description: "أ", actor: "integ" },
      db as never
    );
    const categoryCountBefore = await db.category.count();

    const classification = await createClassification(
      {
        categoryId: category.id,
        name: "تصنيف تكامل",
        keywords: ["يدوي"],
        actor: "integ",
      },
      db as never
    );

    const withKeywords = await updateClassification(
      classification.id,
      { keywords: ["يدوي", "مستورد"], actor: "integ" },
      db as never
    );
    const reloaded = await db.classification.findUniqueOrThrow({
      where: { id: classification.id },
    });
    expect(reloaded.keywords).toEqual(["يدوي", "مستورد"]);
    expect(withKeywords.id).toBe(classification.id);

    const updatedCategory = await updateCategory(
      category.id,
      { name: category.nameAr, description: "وصف محدّث", actor: "integ" },
      db as never
    );
    expect(updatedCategory.id).toBe(category.id);
    expect(await db.category.count()).toBe(categoryCountBefore);

    const sibling = await createClassification(
      {
        categoryId: category.id,
        name: "تصنيف ثانٍ",
        keywords: [],
        actor: "integ",
      },
      db as never
    );

    try {
      await updateClassification(
        sibling.id,
        { keywords: ["يدوي"], actor: "integ" },
        db as never
      );
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ClassificationManagementError);
      expect((error as ClassificationManagementError).code).toBe(
        "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION"
      );
    }

    const siblingReload = await db.classification.findUniqueOrThrow({
      where: { id: sibling.id },
    });
    expect(siblingReload.keywords).toEqual([]);

    const audits = await db.auditLog.findMany({
      where: {
        OR: [
          { entityId: category.id },
          { entityId: classification.id },
          { entityId: sibling.id },
        ],
      },
      orderBy: { occurredAt: "asc" },
    });
    const actions = audits.map((row) => row.action);
    expect(actions).toContain("CATEGORY_CREATED");
    expect(actions).toContain("CATEGORY_UPDATED");
    expect(actions).toContain("CLASSIFICATION_CREATED");
    expect(actions).toContain("CLASSIFICATION_UPDATED");
    expect(actions).toContain("CLASSIFICATION_KEYWORDS_UPDATED");
  });

  it("prevents concurrent updates from linking the same keyword to two classifications", async () => {
    const db = client();
    const category = await createCategory(
      { name: `فئة-تزامن-${crypto.randomUUID().slice(0, 8)}`, actor: "integ" },
      db as never
    );
    const left = await createClassification(
      { categoryId: category.id, name: "يسار", keywords: [], actor: "integ" },
      db as never
    );
    const right = await createClassification(
      { categoryId: category.id, name: "يمين", keywords: [], actor: "integ" },
      db as never
    );

    const secondClient = new PrismaClient();
    try {
      const results = await Promise.allSettled([
        updateClassification(
          left.id,
          { keywords: ["كلمة مشتركة"], actor: "worker-a" },
          db as never
        ),
        updateClassification(
          right.id,
          { keywords: ["كلمة مشتركة"], actor: "worker-b" },
          secondClient as never
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      if (rejected[0]?.status === "rejected") {
        expect(rejected[0].reason).toBeInstanceOf(ClassificationManagementError);
        expect((rejected[0].reason as ClassificationManagementError).code).toBe(
          "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION"
        );
      }

      const rows = await db.classification.findMany({
        where: { id: { in: [left.id, right.id] } },
        select: { id: true, keywords: true },
      });
      const holders = rows.filter((row) => {
        if (!Array.isArray(row.keywords)) return false;
        return row.keywords.some(
          (kw) =>
            typeof kw === "string"
            && normalizeClassificationKeyword(kw) === normalizeClassificationKeyword("كلمة مشتركة")
        );
      });
      expect(holders).toHaveLength(1);
    } finally {
      await secondClient.$disconnect();
    }
  }, 30_000);
});
