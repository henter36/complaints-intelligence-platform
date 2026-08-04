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

let prisma: PrismaClient;
let tempDir: string;
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
    await prisma.$disconnect();
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("classification management SQLite integration", () => {
  it("creates, updates, audits, and rejects keyword conflicts", async () => {
    const category = await createCategory(
      { name: `فئة-تكامل-${crypto.randomUUID().slice(0, 8)}`, description: "أ", actor: "integ" },
      prisma as never
    );
    const categoryCountBefore = await prisma.category.count();

    const classification = await createClassification(
      {
        categoryId: category.id,
        name: "تصنيف تكامل",
        keywords: ["يدوي"],
        actor: "integ",
      },
      prisma as never
    );

    const withKeywords = await updateClassification(
      classification.id,
      { keywords: ["يدوي", "مستورد"], actor: "integ" },
      prisma as never
    );
    const reloaded = await prisma.classification.findUniqueOrThrow({
      where: { id: classification.id },
    });
    expect(reloaded.keywords).toEqual(["يدوي", "مستورد"]);
    expect(withKeywords.id).toBe(classification.id);

    const updatedCategory = await updateCategory(
      category.id,
      { name: category.nameAr, description: "وصف محدّث", actor: "integ" },
      prisma as never
    );
    expect(updatedCategory.id).toBe(category.id);
    expect(await prisma.category.count()).toBe(categoryCountBefore);

    const sibling = await createClassification(
      {
        categoryId: category.id,
        name: "تصنيف ثانٍ",
        keywords: [],
        actor: "integ",
      },
      prisma as never
    );

    try {
      await updateClassification(
        sibling.id,
        { keywords: ["يدوي"], actor: "integ" },
        prisma as never
      );
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ClassificationManagementError);
      expect((error as ClassificationManagementError).code).toBe(
        "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION"
      );
    }

    const siblingReload = await prisma.classification.findUniqueOrThrow({
      where: { id: sibling.id },
    });
    expect(siblingReload.keywords).toEqual([]);

    const audits = await prisma.auditLog.findMany({
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
});
