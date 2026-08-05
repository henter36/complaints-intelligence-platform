import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalizeKeywordsForComparison,
  keywordsMatch,
  rollbackTaxonomyRestructure,
} from "./classification-taxonomy-rollback";
import { buildRollbackToken } from "./classification-taxonomy-proposal";

let prisma: PrismaClient | undefined;
let tempDir: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  tempDir = mkdtempSync(join(tmpdir(), "cip-taxonomy-rollback-kw-"));
  const dbPath = join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: "pipe",
  });
  prisma = new PrismaClient();
}, 60_000);

afterAll(async () => {
  try {
    if (prisma) await prisma.$disconnect();
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
});

function db(): PrismaClient {
  if (!prisma) throw new Error("Prisma not initialized");
  return prisma;
}

describe("keyword canonical comparison", () => {
  it("treats order and equivalent normalization as equal", () => {
    expect(keywordsMatch(["ب", "أ"], ["أ", "ب"])).toBe(true);
    expect(
      canonicalizeKeywordsForComparison(["  كلمة  ", "كلمة"])
    ).toEqual(canonicalizeKeywordsForComparison(["كلمة"]));
  });

  it("detects add/remove and invalid shapes as mismatch", () => {
    expect(keywordsMatch(["أ"], ["أ", "ب"])).toBe(false);
    expect(keywordsMatch(["أ", "ب"], ["أ"])).toBe(false);
    expect(keywordsMatch(["أ"], { not: "array" })).toBe(false);
  });
});

describe("rollback keyword drift", () => {
  it("rolls back KEYWORDS when unchanged and skips when manually edited", async () => {
    const client = db();
    await client.complaint.deleteMany();
    await client.classification.deleteMany();
    await client.category.deleteMany();
    await client.classificationTaxonomyRestructureItem.deleteMany();
    await client.classificationTaxonomyRestructureRun.deleteMany();

    const category = await client.category.create({ data: { nameAr: "فئة-كلمات" } });
    const classification = await client.classification.create({
      data: {
        categoryId: category.id,
        nameAr: "تصنيف-كلمات",
        keywords: ["كلمة-أ", "كلمة-ب"],
      },
    });

    const run = await client.classificationTaxonomyRestructureRun.create({
      data: {
        operation: "APPLY",
        status: "APPLIED",
        proposalHash: "p",
        mappingHash: "m",
        currentTaxonomyFingerprint: "c",
        targetTaxonomyFingerprint: "t",
        manifestHash: "h".repeat(64),
        actor: "test",
        createdCount: 0,
        renamedCount: 0,
        movedCount: 0,
      },
    });

    await client.classificationTaxonomyRestructureItem.create({
      data: {
        runId: run.id,
        sequence: 1,
        entityType: "Classification",
        action: "KEYWORDS",
        entityId: classification.id,
        previousStateJson: { keywords: ["قديمة"] },
        nextStateJson: { keywords: ["كلمة-أ", "كلمة-ب"] },
        result: "APPLIED",
      },
    });

    const confirm = buildRollbackToken(run.id, run.manifestHash, 0);
    const full = await rollbackTaxonomyRestructure(client, {
      runId: run.id,
      confirm,
      actor: "test",
    });
    expect(full.status).toBe("ROLLED_BACK");
    expect(full.skipped).toBe(0);
    expect(
      (await client.classification.findUniqueOrThrow({ where: { id: classification.id } })).keywords
    ).toEqual(["قديمة"]);

    await client.classificationTaxonomyRestructureRun.deleteMany();
    await client.classificationTaxonomyRestructureItem.deleteMany();
    await client.classification.update({
      where: { id: classification.id },
      data: { keywords: ["كلمة-أ", "كلمة-ب"] },
    });

    const run2 = await client.classificationTaxonomyRestructureRun.create({
      data: {
        operation: "APPLY",
        status: "APPLIED",
        proposalHash: "p",
        mappingHash: "m",
        currentTaxonomyFingerprint: "c",
        targetTaxonomyFingerprint: "t",
        manifestHash: "h".repeat(64),
        actor: "test",
        createdCount: 0,
        renamedCount: 0,
        movedCount: 0,
      },
    });
    await client.classificationTaxonomyRestructureItem.create({
      data: {
        runId: run2.id,
        sequence: 1,
        entityType: "Classification",
        action: "KEYWORDS",
        entityId: classification.id,
        previousStateJson: { keywords: ["قديمة"] },
        nextStateJson: { keywords: ["كلمة-أ", "كلمة-ب"] },
        result: "APPLIED",
      },
    });
    await client.classification.update({
      where: { id: classification.id },
      data: { keywords: ["كلمة-أ", "كلمة-ب", "يدوية"] },
    });

    const partial = await rollbackTaxonomyRestructure(client, {
      runId: run2.id,
      confirm: buildRollbackToken(run2.id, run2.manifestHash, 0),
      actor: "test",
    });
    expect(partial.status).toBe("PARTIALLY_ROLLED_BACK");
    expect(partial.skipped).toBeGreaterThan(0);
    const skipped = await client.classificationTaxonomyRestructureItem.findMany({
      where: { runId: run2.id, result: "ROLLBACK_SKIPPED" },
    });
    expect(skipped.every((i) => i.skipReason === "ENTITY_CHANGED_AFTER_APPLY")).toBe(true);
    expect(
      (await client.classification.findUniqueOrThrow({ where: { id: classification.id } })).keywords
    ).toEqual(["كلمة-أ", "كلمة-ب", "يدوية"]);
  }, 60_000);

  it("allows keyword reorder-only and skips on RENAME keyword drift", async () => {
    const client = db();
    await client.complaint.deleteMany();
    await client.classification.deleteMany();
    await client.category.deleteMany();
    await client.classificationTaxonomyRestructureItem.deleteMany();
    await client.classificationTaxonomyRestructureRun.deleteMany();

    const category = await client.category.create({ data: { nameAr: "فئة-ترتيب" } });
    const classification = await client.classification.create({
      data: {
        categoryId: category.id,
        nameAr: "اسم-نهائي",
        keywords: ["ب", "أ"],
      },
    });
    const run = await client.classificationTaxonomyRestructureRun.create({
      data: {
        operation: "APPLY",
        status: "APPLIED",
        proposalHash: "p",
        mappingHash: "m",
        currentTaxonomyFingerprint: "c",
        targetTaxonomyFingerprint: "t",
        manifestHash: "h".repeat(64),
        actor: "test",
        renamedCount: 1,
      },
    });
    await client.classificationTaxonomyRestructureItem.create({
      data: {
        runId: run.id,
        sequence: 1,
        entityType: "Classification",
        action: "RENAME",
        entityId: classification.id,
        previousStateJson: {
          nameAr: "اسم-قديم",
          categoryId: category.id,
          keywords: ["قديمة"],
        },
        nextStateJson: {
          nameAr: "اسم-نهائي",
          categoryId: category.id,
          keywords: ["أ", "ب"],
        },
        result: "APPLIED",
      },
    });

    const reorderOk = await rollbackTaxonomyRestructure(client, {
      runId: run.id,
      confirm: buildRollbackToken(run.id, run.manifestHash, 1),
      actor: "test",
    });
    expect(reorderOk.status).toBe("ROLLED_BACK");
    expect(
      (await client.classification.findUniqueOrThrow({ where: { id: classification.id } })).nameAr
    ).toBe("اسم-قديم");

    await client.classification.update({
      where: { id: classification.id },
      data: { nameAr: "اسم-نهائي", keywords: ["أ", "ب"] },
    });
    await client.classificationTaxonomyRestructureRun.deleteMany();
    await client.classificationTaxonomyRestructureItem.deleteMany();
    const run2 = await client.classificationTaxonomyRestructureRun.create({
      data: {
        operation: "APPLY",
        status: "APPLIED",
        proposalHash: "p",
        mappingHash: "m",
        currentTaxonomyFingerprint: "c",
        targetTaxonomyFingerprint: "t",
        manifestHash: "h".repeat(64),
        actor: "test",
        renamedCount: 1,
      },
    });
    await client.classificationTaxonomyRestructureItem.create({
      data: {
        runId: run2.id,
        sequence: 1,
        entityType: "Classification",
        action: "RENAME",
        entityId: classification.id,
        previousStateJson: {
          nameAr: "اسم-قديم",
          categoryId: category.id,
          keywords: ["قديمة"],
        },
        nextStateJson: {
          nameAr: "اسم-نهائي",
          categoryId: category.id,
          keywords: ["أ", "ب"],
        },
        result: "APPLIED",
      },
    });
    await client.classification.update({
      where: { id: classification.id },
      data: { keywords: ["أ"] },
    });
    const drifted = await rollbackTaxonomyRestructure(client, {
      runId: run2.id,
      confirm: buildRollbackToken(run2.id, run2.manifestHash, 1),
      actor: "test",
    });
    expect(drifted.status).toBe("PARTIALLY_ROLLED_BACK");
    expect(
      (await client.classification.findUniqueOrThrow({ where: { id: classification.id } })).keywords
    ).toEqual(["أ"]);
  }, 60_000);
});
