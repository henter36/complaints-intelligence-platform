import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient, ComplaintStatus, ComplaintPriority } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyTaxonomyRestructure,
  buildConfirmationToken,
  computeManifestHash,
  computeTaxonomyShapeFingerprint,
  emptyPlan,
  loadCurrentTaxonomy,
  rollbackTaxonomyRestructure,
  writeManifestAtomically,
  RESTRUCTURE_ERROR_CODES,
  type RestructureManifest,
  type PlanChange,
} from "./classification-taxonomy-restructure";

let prisma: PrismaClient | undefined;
let tempDir: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  tempDir = mkdtempSync(join(tmpdir(), "cip-taxonomy-apply-"));
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

function renameChange(input: {
  currentId: string;
  currentName: string;
  targetName: string;
  currentCategory?: string | null;
  targetCategory?: string | null;
  action?: string;
}): PlanChange {
  return {
    currentId: input.currentId,
    currentName: input.currentName,
    targetName: input.targetName,
    currentCategory: input.currentCategory ?? null,
    targetCategory: input.targetCategory ?? null,
    action: input.action ?? "RENAME",
    reason: "test",
    affectedExistingComplaintCount: 0,
  };
}

async function writeApplyManifest(
  planOverrides: Partial<ReturnType<typeof emptyPlan>>,
  path: string
): Promise<{ manifest: RestructureManifest; current: Awaited<ReturnType<typeof loadCurrentTaxonomy>> }> {
  const client = db();
  const current = await loadCurrentTaxonomy(client);
  const plan = { ...emptyPlan(), ...planOverrides };
  const targetCats = current.categories
    .filter((c) => c.isActive && !c.isDeleted)
    .map((c) => {
      const rename = plan.categoriesToRename.find((r) => r.currentId === c.id);
      return {
        nameAr: rename?.targetName ?? c.nameAr,
        isActive: true,
        isDeleted: false,
      };
    });
  const targetCls = current.classifications
    .filter((c) => c.isActive && !c.isDeleted)
    .map((c) => {
      const mutation = [
        ...plan.classificationsToRename,
        ...plan.classificationsToMove,
      ].find((r) => r.currentId === c.id);
      return {
        nameAr: mutation?.targetName ?? c.nameAr,
        categoryName: mutation?.targetCategory ?? c.categoryName,
        keywords: c.keywords,
        isActive: true,
        isDeleted: false,
      };
    });
  const withoutHash: Omit<RestructureManifest, "manifestHash" | "confirmationToken"> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    proposalHash: "p".repeat(64),
    mappingHash: "m".repeat(64),
    currentTaxonomyFingerprint: current.fingerprint,
    targetTaxonomyFingerprint: computeTaxonomyShapeFingerprint(targetCats, targetCls),
    plan,
    totals: {
      changeCount: 1,
      categoriesToCreate: plan.categoriesToCreate.length,
      categoriesToRename: plan.categoriesToRename.length,
      classificationsToCreate: plan.classificationsToCreate.length,
      classificationsToRename: plan.classificationsToRename.length,
      classificationsToMove: plan.classificationsToMove.length,
      classificationsToDeactivate: plan.classificationsToDeactivate.length,
      keywordChangeCount: 0,
      legacyComplaintConsistencyUpdateCount: 0,
      unclassifiedComplaintsUntouched: true,
    },
  };
  const manifestHash = computeManifestHash(withoutHash);
  const confirmationToken = buildConfirmationToken(manifestHash, withoutHash.totals.changeCount);
  const manifest: RestructureManifest = { ...withoutHash, manifestHash, confirmationToken };
  await writeManifestAtomically(path, manifest, true);
  return { manifest, current };
}

async function resetTaxonomy(): Promise<void> {
  const client = db();
  await client.complaint.deleteMany();
  await client.classification.deleteMany();
  await client.category.deleteMany();
  await client.classificationTaxonomyRestructureItem.deleteMany();
  await client.classificationTaxonomyRestructureRun.deleteMany();
}

describe("taxonomy apply rename cycles and collisions", () => {
  it("swaps category names A↔B via two-phase rename", async () => {
    const client = db();
    await resetTaxonomy();
    const a = await client.category.create({ data: { nameAr: "فئة-أ" } });
    const b = await client.category.create({ data: { nameAr: "فئة-ب" } });
    const plan = emptyPlan();
    plan.categoriesToRename = [
      renameChange({ currentId: a.id, currentName: "فئة-أ", targetName: "فئة-ب" }),
      renameChange({ currentId: b.id, currentName: "فئة-ب", targetName: "فئة-أ" }),
    ];
    plan.finalCategoryTargets = {
      "فئة-ب": { reuseId: a.id },
      "فئة-أ": { reuseId: b.id },
    };
    const path = join(tempDir!, "swap-cat.json");
    const { manifest } = await writeApplyManifest(plan, path);
    const applied = await applyTaxonomyRestructure(client, {
      manifestPath: path,
      confirm: manifest.confirmationToken,
      actor: "test",
    });
    expect(applied.status).toBe("APPLIED");
    const aAfter = await client.category.findUniqueOrThrow({ where: { id: a.id } });
    const bAfter = await client.category.findUniqueOrThrow({ where: { id: b.id } });
    expect(aAfter.nameAr).toBe("فئة-ب");
    expect(bAfter.nameAr).toBe("فئة-أ");
    const items = await client.classificationTaxonomyRestructureItem.findMany({
      where: { runId: applied.runId, action: "RENAME" },
    });
    expect(items).toHaveLength(2);
    for (const item of items) {
      const prev = item.previousStateJson as { nameAr?: string };
      const next = item.nextStateJson as { nameAr?: string };
      expect(prev.nameAr).not.toMatch(/__taxonomy_tmp_/);
      expect(next.nameAr).not.toMatch(/__taxonomy_tmp_/);
    }

    const rolled = await rollbackTaxonomyRestructure(client, {
      runId: applied.runId,
      confirm: applied.rollbackToken,
      actor: "test",
    });
    expect(rolled.status).toBe("ROLLED_BACK");
    expect((await client.category.findUniqueOrThrow({ where: { id: a.id } })).nameAr).toBe("فئة-أ");
    expect((await client.category.findUniqueOrThrow({ where: { id: b.id } })).nameAr).toBe("فئة-ب");
  }, 60_000);

  it("swaps classification names within the same category", async () => {
    const client = db();
    await resetTaxonomy();
    const cat = await client.category.create({ data: { nameAr: "فئة-واحدة" } });
    const x = await client.classification.create({
      data: { categoryId: cat.id, nameAr: "تصنيف-س", keywords: [] },
    });
    const y = await client.classification.create({
      data: { categoryId: cat.id, nameAr: "تصنيف-ص", keywords: [] },
    });
    const plan = emptyPlan();
    plan.classificationsToRename = [
      renameChange({
        currentId: x.id,
        currentName: "تصنيف-س",
        targetName: "تصنيف-ص",
        currentCategory: "فئة-واحدة",
        targetCategory: "فئة-واحدة",
      }),
      renameChange({
        currentId: y.id,
        currentName: "تصنيف-ص",
        targetName: "تصنيف-س",
        currentCategory: "فئة-واحدة",
        targetCategory: "فئة-واحدة",
      }),
    ];
    plan.finalCategoryTargets = { "فئة-واحدة": { reuseId: cat.id } };
    plan.finalClassificationTargets = {
      "فئة-واحدة::تصنيف-ص": {
        categoryName: "فئة-واحدة",
        classificationName: "تصنيف-ص",
        reuseId: x.id,
      },
      "فئة-واحدة::تصنيف-س": {
        categoryName: "فئة-واحدة",
        classificationName: "تصنيف-س",
        reuseId: y.id,
      },
    };
    const path = join(tempDir!, "swap-cls.json");
    const { manifest } = await writeApplyManifest(plan, path);
    const applied = await applyTaxonomyRestructure(client, {
      manifestPath: path,
      confirm: manifest.confirmationToken,
      actor: "test",
    });
    expect(applied.status).toBe("APPLIED");
    expect((await client.classification.findUniqueOrThrow({ where: { id: x.id } })).nameAr).toBe(
      "تصنيف-ص"
    );
    expect((await client.classification.findUniqueOrThrow({ where: { id: y.id } })).nameAr).toBe(
      "تصنيف-س"
    );
    const rolled = await rollbackTaxonomyRestructure(client, {
      runId: applied.runId,
      confirm: applied.rollbackToken,
      actor: "test",
    });
    expect(rolled.status).toBe("ROLLED_BACK");
    expect((await client.classification.findUniqueOrThrow({ where: { id: x.id } })).nameAr).toBe(
      "تصنيف-س"
    );
    expect((await client.classification.findUniqueOrThrow({ where: { id: y.id } })).nameAr).toBe(
      "تصنيف-ص"
    );
  }, 60_000);

  it("chains category renames A→B→C without collision", async () => {
    const client = db();
    await resetTaxonomy();
    const a = await client.category.create({ data: { nameAr: "سلسلة-أ" } });
    const b = await client.category.create({ data: { nameAr: "سلسلة-ب" } });
    const plan = emptyPlan();
    plan.categoriesToRename = [
      renameChange({ currentId: a.id, currentName: "سلسلة-أ", targetName: "سلسلة-ب" }),
      renameChange({ currentId: b.id, currentName: "سلسلة-ب", targetName: "سلسلة-ج" }),
    ];
    plan.finalCategoryTargets = {
      "سلسلة-ب": { reuseId: a.id },
      "سلسلة-ج": { reuseId: b.id },
    };
    const path = join(tempDir!, "chain-cat.json");
    const { manifest } = await writeApplyManifest(plan, path);
    const applied = await applyTaxonomyRestructure(client, {
      manifestPath: path,
      confirm: manifest.confirmationToken,
      actor: "test",
    });
    expect(applied.status).toBe("APPLIED");
    expect((await client.category.findUniqueOrThrow({ where: { id: a.id } })).nameAr).toBe("سلسلة-ب");
    expect((await client.category.findUniqueOrThrow({ where: { id: b.id } })).nameAr).toBe("سلسلة-ج");
  }, 60_000);

  it("rejects create colliding with inactive category and does not create a run", async () => {
    const client = db();
    await resetTaxonomy();
    await client.category.create({
      data: { nameAr: "اسم-محجوز", isActive: false },
    });
    const plan = emptyPlan();
    plan.categoriesToCreate = [
      renameChange({
        currentId: "",
        currentName: "",
        targetName: "اسم-محجوز",
        action: "CREATE",
      }),
    ];
    plan.finalCategoryTargets = { "اسم-محجوز": { reuseId: null } };
    const path = join(tempDir!, "inactive-cat.json");
    const { manifest } = await writeApplyManifest(plan, path);
    const runsBefore = await client.classificationTaxonomyRestructureRun.count();
    await expect(
      applyTaxonomyRestructure(client, {
        manifestPath: path,
        confirm: manifest.confirmationToken,
        actor: "test",
      })
    ).rejects.toMatchObject({ code: RESTRUCTURE_ERROR_CODES.TAXONOMY_RENAME_COLLISION });
    expect(await client.classificationTaxonomyRestructureRun.count()).toBe(runsBefore);
    expect(await client.category.count({ where: { isActive: true } })).toBe(0);
  }, 60_000);

  it("rejects create colliding with inactive classification path", async () => {
    const client = db();
    await resetTaxonomy();
    const cat = await client.category.create({ data: { nameAr: "فئة-قائمة" } });
    await client.classification.create({
      data: {
        categoryId: cat.id,
        nameAr: "تصنيف-محجوز",
        keywords: [],
        isActive: false,
      },
    });
    const plan = emptyPlan();
    plan.categoriesToKeep = [
      renameChange({
        currentId: cat.id,
        currentName: "فئة-قائمة",
        targetName: "فئة-قائمة",
        action: "KEEP",
      }),
    ];
    plan.classificationsToCreate = [
      renameChange({
        currentId: "",
        currentName: "",
        targetName: "تصنيف-محجوز",
        targetCategory: "فئة-قائمة",
        action: "CREATE",
      }),
    ];
    plan.finalCategoryTargets = { "فئة-قائمة": { reuseId: cat.id } };
    plan.finalClassificationTargets = {
      "فئة-قائمة::تصنيف-محجوز": {
        categoryName: "فئة-قائمة",
        classificationName: "تصنيف-محجوز",
        reuseId: null,
      },
    };
    const path = join(tempDir!, "inactive-cls.json");
    const { manifest } = await writeApplyManifest(plan, path);
    await expect(
      applyTaxonomyRestructure(client, {
        manifestPath: path,
        confirm: manifest.confirmationToken,
        actor: "test",
      })
    ).rejects.toMatchObject({ code: RESTRUCTURE_ERROR_CODES.TAXONOMY_RENAME_COLLISION });
  }, 60_000);

  it("records CATEGORY_CONSISTENCY only for mismatched complaints", async () => {
    const client = db();
    await resetTaxonomy();
    const from = await client.category.create({ data: { nameAr: "من" } });
    const to = await client.category.create({ data: { nameAr: "إلى" } });
    const cls = await client.classification.create({
      data: { categoryId: from.id, nameAr: "منقول", keywords: [] },
    });
    const mismatched = await client.complaint.create({
      data: {
        subject: "mismatch",
        description: "d",
        status: ComplaintStatus.NEW,
        priority: ComplaintPriority.MEDIUM,
        channel: "OTHER",
        region: "الرياض",
        categoryId: from.id,
        classificationId: cls.id,
        receivedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const alreadyOk = await client.complaint.create({
      data: {
        subject: "ok",
        description: "d",
        status: ComplaintStatus.NEW,
        priority: ComplaintPriority.MEDIUM,
        channel: "OTHER",
        region: "الرياض",
        categoryId: to.id,
        classificationId: cls.id,
        receivedAt: new Date("2026-01-02T00:00:00Z"),
      },
    });
    const plan = emptyPlan();
    plan.classificationsToMove = [
      renameChange({
        currentId: cls.id,
        currentName: "منقول",
        targetName: "منقول",
        currentCategory: "من",
        targetCategory: "إلى",
        action: "MOVE",
      }),
    ];
    plan.finalCategoryTargets = {
      من: { reuseId: from.id },
      إلى: { reuseId: to.id },
    };
    plan.finalClassificationTargets = {
      "إلى::منقول": {
        categoryName: "إلى",
        classificationName: "منقول",
        reuseId: cls.id,
      },
    };
    const path = join(tempDir!, "consistency.json");
    const { manifest } = await writeApplyManifest(plan, path);
    const applied = await applyTaxonomyRestructure(client, {
      manifestPath: path,
      confirm: manifest.confirmationToken,
      actor: "test",
    });
    const consistency = await client.classificationTaxonomyRestructureItem.findMany({
      where: { runId: applied.runId, action: "CATEGORY_CONSISTENCY" },
    });
    expect(consistency).toHaveLength(1);
    expect(consistency[0]?.entityId).toBe(mismatched.id);
    expect(
      (await client.complaint.findUniqueOrThrow({ where: { id: mismatched.id } })).categoryId
    ).toBe(to.id);
    expect(
      (await client.complaint.findUniqueOrThrow({ where: { id: alreadyOk.id } })).categoryId
    ).toBe(to.id);

    const postApply = await client.complaint.create({
      data: {
        subject: "after",
        description: "d",
        status: ComplaintStatus.NEW,
        priority: ComplaintPriority.LOW,
        channel: "OTHER",
        region: "جدة",
        categoryId: to.id,
        classificationId: cls.id,
        receivedAt: new Date("2026-01-03T00:00:00Z"),
      },
    });
    await client.complaint.update({
      where: { id: mismatched.id },
      data: { categoryId: from.id },
    });

    const rolled = await rollbackTaxonomyRestructure(client, {
      runId: applied.runId,
      confirm: applied.rollbackToken,
      actor: "test",
    });
    expect(rolled.skipped).toBeGreaterThan(0);
    expect(
      (await client.complaint.findUniqueOrThrow({ where: { id: mismatched.id } })).categoryId
    ).toBe(from.id);
    expect(
      (await client.complaint.findUniqueOrThrow({ where: { id: postApply.id } })).categoryId
    ).toBe(to.id);
  }, 60_000);
});
