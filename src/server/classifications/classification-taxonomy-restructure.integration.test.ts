import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient, ComplaintStatus, ComplaintPriority, Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyTaxonomyRestructure,
  previewTaxonomyRestructure,
  rollbackTaxonomyRestructure,
  verifyTaxonomyRestructure,
  RESTRUCTURE_ERROR_CODES,
  buildRollbackToken,
} from "./classification-taxonomy-restructure";
import { resolveSourceDetailClassification } from "./source-detail-classification-resolver";
import { createClassification, ClassificationManagementError } from "./classification-management-service";

const FIXTURE_DIR = join(process.cwd(), "src/server/classifications/__fixtures__");
const PROPOSAL = join(FIXTURE_DIR, "mini-proposed-taxonomy.json");
const MAPPING = join(FIXTURE_DIR, "mini-source-detail-mapping.csv");

let prisma: PrismaClient | undefined;
let tempDir: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  tempDir = mkdtempSync(join(tmpdir(), "cip-taxonomy-restructure-"));
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

async function seedLegacyTaxonomy() {
  const client = db();
  await client.complaint.deleteMany();
  await client.classification.deleteMany();
  await client.category.deleteMany();
  await client.classificationTaxonomyRestructureItem.deleteMany();
  await client.classificationTaxonomyRestructureRun.deleteMany();

  const health = await client.category.create({
    data: { id: "cat_health", nameAr: "الرعاية الصحية" },
  });
  const services = await client.category.create({
    data: { id: "cat_services", nameAr: "الخدمات" },
  });

  const appointments = await client.classification.create({
    data: {
      id: "cls_appointments",
      categoryId: health.id,
      nameAr: "المواعيد",
      keywords: ["عدم خروجه لموعد"],
    },
  });
  const conduct = await client.classification.create({
    data: {
      id: "cls_conduct",
      categoryId: services.id,
      nameAr: "السلوك المهني",
      keywords: ["سوء التعامل"],
    },
  });

  const classifiedAppointment = await client.complaint.create({
    data: {
      subject: "موعد",
      description: "legacy",
      status: ComplaintStatus.NEW,
      priority: ComplaintPriority.MEDIUM,
      channel: "OTHER",
      region: "الرياض",
      categoryId: health.id,
      classificationId: appointments.id,
      receivedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const classifiedConduct = await client.complaint.create({
    data: {
      subject: "سلوك",
      description: "legacy",
      status: ComplaintStatus.NEW,
      priority: ComplaintPriority.MEDIUM,
      channel: "OTHER",
      region: "الرياض",
      categoryId: services.id,
      classificationId: conduct.id,
      receivedAt: new Date("2026-01-02T00:00:00Z"),
    },
  });

  const unclassifiedIds = [];
  for (let i = 0; i < 3; i += 1) {
    const row = await client.complaint.create({
      data: {
        subject: "غير مصنف",
        description: "unclassified",
        status: ComplaintStatus.NEW,
        priority: ComplaintPriority.LOW,
        channel: "OTHER",
        region: "جدة",
        receivedAt: new Date("2026-01-03T00:00:00Z"),
        sourceDetail: i === 0 ? "أخرى" : i === 1 ? "عدم خروجه لموعد" : "لم يتلقى العلاج اللازم",
      },
    });
    unclassifiedIds.push(row.id);
  }

  return {
    health,
    services,
    appointments,
    conduct,
    classifiedAppointment,
    classifiedConduct,
    unclassifiedIds,
  };
}

describe("classification taxonomy restructure integration", () => {
  it("dry-run → apply → verify → full rollback preserves ids and ordering", async () => {
    const client = db();
    const seed = await seedLegacyTaxonomy();
    const manifestPath = join(tempDir!, "manifest.json");

    const categoryCountBefore = await client.category.count();
    const classificationCountBefore = await client.classification.count();

    const preview = await previewTaxonomyRestructure(client, {
      proposalPath: PROPOSAL,
      mappingPath: MAPPING,
      manifestPath,
      overwrite: true,
    });

    expect(preview.confirmationToken.startsWith("RESTRUCTURE-")).toBe(true);
    expect(preview.totals.unclassifiedComplaintsUntouched).toBe(true);
    expect(preview.planSummary.categoriesToCreate.some((c) => c === "بيانات غير محددة")).toBe(true);
    expect(preview.planSummary.classificationsToRename.some((c) => c.includes("المواعيد"))).toBe(true);
    expect(preview.planSummary.classificationsToMove.some((c) => c.includes("السلوك المهني"))).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    expect(await client.category.count()).toBe(categoryCountBefore);
    expect(await client.classification.count()).toBe(classificationCountBefore);
    expect(await client.classificationTaxonomyRestructureRun.count()).toBe(0);

    const applied = await applyTaxonomyRestructure(client, {
      manifestPath,
      confirm: preview.confirmationToken,
      actor: "test-actor",
    });
    expect(applied.status).toBe("APPLIED");
    expect(applied.runId).toBeTruthy();

    const applyItems = await client.classificationTaxonomyRestructureItem.findMany({
      where: { runId: applied.runId },
      orderBy: { sequence: "asc" },
    });
    expect(applyItems.length).toBeGreaterThan(1);
    expect(applyItems.map((i) => i.sequence)).toEqual(
      Array.from({ length: applyItems.length }, (_, i) => i + 1)
    );
    expect(new Set(applyItems.map((i) => i.sequence)).size).toBe(applyItems.length);

    const renamed = await client.classification.findUniqueOrThrow({
      where: { id: seed.appointments.id },
    });
    expect(renamed.nameAr).toBe("المواعيد والإحالات الصحية");

    const moved = await client.classification.findUniqueOrThrow({
      where: { id: seed.conduct.id },
      include: { category: true },
    });
    expect(moved.nameAr).toBe("تعامل الموظفين والسلوك المهني");
    expect(moved.category.nameAr).toBe("السلوك المهني والتعامل");

    const appointmentComplaint = await client.complaint.findUniqueOrThrow({
      where: { id: seed.classifiedAppointment.id },
    });
    expect(appointmentComplaint.classificationId).toBe(seed.appointments.id);

    const conductComplaint = await client.complaint.findUniqueOrThrow({
      where: { id: seed.classifiedConduct.id },
    });
    expect(conductComplaint.classificationId).toBe(seed.conduct.id);
    expect(conductComplaint.categoryId).toBe(moved.categoryId);

    for (const id of seed.unclassifiedIds) {
      const row = await client.complaint.findUniqueOrThrow({ where: { id } });
      expect(row.classificationId).toBeNull();
    }

    const active = await client.classification.findMany({
      where: { isActive: true, isDeleted: false },
      include: { category: true },
    });
    const candidates = active.map((c) => ({
      id: c.id,
      nameAr: c.nameAr,
      keywords: c.keywords,
      isActive: c.isActive,
      isDeleted: c.isDeleted,
      category: {
        id: c.category.id,
        nameAr: c.category.nameAr,
        isActive: c.category.isActive,
        isDeleted: c.category.isDeleted,
      },
    }));
    for (const detail of ["عدم خروجه لموعد", "لم يتلقى العلاج اللازم", "أخرى"]) {
      const resolved = resolveSourceDetailClassification({
        sourceDetail: detail,
        classifications: candidates,
      });
      expect(resolved.status).toBe("MATCHED");
    }
    const otherResolved = resolveSourceDetailClassification({
      sourceDetail: "أخرى",
      classifications: candidates,
    });
    expect(otherResolved.status).toBe("MATCHED");
    if (otherResolved.status === "MATCHED") {
      expect(otherResolved.match.classificationName).toBe("أخرى تحتاج مراجعة");
    }

    const verified = await verifyTaxonomyRestructure(client, {
      runId: applied.runId,
      proposalPath: PROPOSAL,
      mappingPath: MAPPING,
    });
    expect(verified.ok).toBe(true);

    await client.category.create({ data: { nameAr: `فئة دخيلة-${crypto.randomUUID().slice(0, 6)}` } });
    await expect(
      applyTaxonomyRestructure(client, {
        manifestPath,
        confirm: preview.confirmationToken,
        actor: "test-actor",
      })
    ).rejects.toMatchObject({
      code: RESTRUCTURE_ERROR_CODES.CLASSIFICATION_TAXONOMY_CHANGED_AFTER_PREVIEW,
    });

    const seed2 = await seedLegacyTaxonomy();
    const createdCategoryIdsBefore = new Set(
      (await client.category.findMany({ select: { id: true } })).map((c) => c.id)
    );
    const createdClassificationIdsBefore = new Set(
      (await client.classification.findMany({ select: { id: true } })).map((c) => c.id)
    );
    const manifest2 = join(tempDir!, "manifest-2.json");
    const preview2 = await previewTaxonomyRestructure(client, {
      proposalPath: PROPOSAL,
      mappingPath: MAPPING,
      manifestPath: manifest2,
      overwrite: true,
    });
    const applied2 = await applyTaxonomyRestructure(client, {
      manifestPath: manifest2,
      confirm: preview2.confirmationToken,
      actor: "test-actor",
    });

    const applyItems2 = await client.classificationTaxonomyRestructureItem.findMany({
      where: { runId: applied2.runId },
      orderBy: { sequence: "asc" },
    });
    const sameCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    await client.classificationTaxonomyRestructureItem.updateMany({
      where: { runId: applied2.runId },
      data: { createdAt: sameCreatedAt },
    });
    const afterStamp = await client.classificationTaxonomyRestructureItem.findMany({
      where: { runId: applied2.runId },
      orderBy: [{ sequence: "desc" }, { id: "desc" }],
    });
    expect(afterStamp.every((i) => i.createdAt.getTime() === sameCreatedAt.getTime())).toBe(true);
    expect(afterStamp.map((i) => i.sequence)).toEqual(
      [...applyItems2].reverse().map((i) => i.sequence)
    );

    const rolled = await rollbackTaxonomyRestructure(client, {
      runId: applied2.runId,
      confirm: applied2.rollbackToken,
      actor: "test-actor",
    });
    expect(rolled.status).toBe("ROLLED_BACK");
    expect(rolled.skipped).toBe(0);
    expect(rolled.rolledBack).toBeGreaterThan(0);

    const appointmentsAfter = await client.classification.findUniqueOrThrow({
      where: { id: seed2.appointments.id },
    });
    expect(appointmentsAfter.nameAr).toBe("المواعيد");
    expect(appointmentsAfter.keywords).toEqual(["عدم خروجه لموعد"]);

    const conductAfter = await client.classification.findUniqueOrThrow({
      where: { id: seed2.conduct.id },
    });
    expect(conductAfter.nameAr).toBe("السلوك المهني");
    expect(conductAfter.categoryId).toBe(seed2.services.id);
    expect(conductAfter.keywords).toEqual(["سوء التعامل"]);

    const conductComplaintAfter = await client.complaint.findUniqueOrThrow({
      where: { id: seed2.classifiedConduct.id },
      include: { classification: true },
    });
    expect(conductComplaintAfter.categoryId).toBe(seed2.services.id);
    expect(conductComplaintAfter.categoryId).toBe(conductComplaintAfter.classification?.categoryId);

    const createdCategories = await client.category.findMany({
      where: { id: { notIn: [...createdCategoryIdsBefore] } },
    });
    for (const cat of createdCategories) {
      expect(cat.isActive).toBe(false);
    }
    const createdClassifications = await client.classification.findMany({
      where: { id: { notIn: [...createdClassificationIdsBefore] } },
    });
    for (const cls of createdClassifications) {
      expect(cls.isActive).toBe(false);
    }

    const classified = await client.complaint.findMany({
      where: { isDeleted: false, classificationId: { not: null } },
      include: { classification: true },
    });
    for (const complaint of classified) {
      expect(complaint.categoryId).toBe(complaint.classification?.categoryId);
    }
  }, 90_000);

  it("rolls back MOVE_AND_RENAME after CATEGORY_CONSISTENCY when sequences dictate order", async () => {
    const client = db();
    await seedLegacyTaxonomy();
    const fromCategory = await client.category.create({
      data: { nameAr: `من-${crypto.randomUUID().slice(0, 6)}` },
    });
    const toCategory = await client.category.create({
      data: { nameAr: `إلى-${crypto.randomUUID().slice(0, 6)}` },
    });
    const classification = await client.classification.create({
      data: {
        categoryId: fromCategory.id,
        nameAr: `تصنيف-منقول-${crypto.randomUUID().slice(0, 6)}`,
        keywords: ["كلمة قديمة"],
      },
    });
    const complaint = await client.complaint.create({
      data: {
        subject: "نقل",
        description: "legacy",
        status: ComplaintStatus.NEW,
        priority: ComplaintPriority.MEDIUM,
        channel: "OTHER",
        region: "الرياض",
        categoryId: toCategory.id,
        classificationId: classification.id,
        receivedAt: new Date("2026-01-04T00:00:00Z"),
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
        renamedCount: 1,
        movedCount: 1,
      },
    });

    const sameCreatedAt = new Date("2026-02-02T00:00:00.000Z");
    await client.classificationTaxonomyRestructureItem.create({
      data: {
        runId: run.id,
        sequence: 1,
        entityType: "Complaint",
        action: "CATEGORY_CONSISTENCY",
        entityId: complaint.id,
        previousStateJson: {
          categoryId: fromCategory.id,
          classificationId: classification.id,
        },
        nextStateJson: {
          categoryId: toCategory.id,
          classificationId: classification.id,
        },
        result: "APPLIED",
        createdAt: sameCreatedAt,
      },
    });
    await client.classificationTaxonomyRestructureItem.create({
      data: {
        runId: run.id,
        sequence: 2,
        entityType: "Classification",
        action: "MOVE_AND_RENAME",
        entityId: classification.id,
        previousStateJson: {
          nameAr: "اسم قديم",
          categoryId: fromCategory.id,
          keywords: ["كلمة قديمة"],
        },
        nextStateJson: {
          nameAr: classification.nameAr,
          categoryId: toCategory.id,
          keywords: ["كلمة جديدة"],
        },
        result: "APPLIED",
        createdAt: sameCreatedAt,
      },
    });

    await client.classification.update({
      where: { id: classification.id },
      data: {
        nameAr: classification.nameAr,
        categoryId: toCategory.id,
        keywords: ["كلمة جديدة"],
      },
    });

    const ordered = await client.classificationTaxonomyRestructureItem.findMany({
      where: { runId: run.id, result: "APPLIED" },
      orderBy: [{ sequence: "desc" }, { id: "desc" }],
    });
    expect(ordered.map((i) => i.action)).toEqual(["MOVE_AND_RENAME", "CATEGORY_CONSISTENCY"]);

    const confirm = buildRollbackToken(run.id, run.manifestHash, 2);
    const rolled = await rollbackTaxonomyRestructure(client, {
      runId: run.id,
      confirm,
      actor: "test-actor",
    });
    expect(rolled.status).toBe("ROLLED_BACK");
    expect(rolled.skipped).toBe(0);

    const classificationAfter = await client.classification.findUniqueOrThrow({
      where: { id: classification.id },
    });
    expect(classificationAfter.categoryId).toBe(fromCategory.id);
    expect(classificationAfter.nameAr).toBe("اسم قديم");
    expect(classificationAfter.keywords).toEqual(["كلمة قديمة"]);

    const complaintAfter = await client.complaint.findUniqueOrThrow({
      where: { id: complaint.id },
      include: { classification: true },
    });
    expect(complaintAfter.categoryId).toBe(fromCategory.id);
    expect(complaintAfter.categoryId).toBe(complaintAfter.classification?.categoryId);
  }, 60_000);

  it("assigns independent sequences per run and rejects duplicates", async () => {
    const client = db();
    await seedLegacyTaxonomy();
    const manifestPath = join(tempDir!, "manifest-seq.json");
    const preview = await previewTaxonomyRestructure(client, {
      proposalPath: PROPOSAL,
      mappingPath: MAPPING,
      manifestPath,
      overwrite: true,
    });
    const applied = await applyTaxonomyRestructure(client, {
      manifestPath,
      confirm: preview.confirmationToken,
      actor: "test-actor",
    });

    const items = await client.classificationTaxonomyRestructureItem.findMany({
      where: { runId: applied.runId },
      orderBy: { sequence: "asc" },
    });
    expect(items[0]?.sequence).toBe(1);
    expect(items.at(-1)?.sequence).toBe(items.length);

    await seedLegacyTaxonomy();
    const manifestB = join(tempDir!, "manifest-seq-b.json");
    const previewB = await previewTaxonomyRestructure(client, {
      proposalPath: PROPOSAL,
      mappingPath: MAPPING,
      manifestPath: manifestB,
      overwrite: true,
    });
    const appliedB = await applyTaxonomyRestructure(client, {
      manifestPath: manifestB,
      confirm: previewB.confirmationToken,
      actor: "test-actor",
    });
    const itemsB = await client.classificationTaxonomyRestructureItem.findMany({
      where: { runId: appliedB.runId },
      orderBy: { sequence: "asc" },
    });
    expect(itemsB[0]?.sequence).toBe(1);

    await expect(
      client.classificationTaxonomyRestructureItem.create({
        data: {
          runId: appliedB.runId,
          sequence: 1,
          entityType: "Category",
          action: "CREATE",
          result: "APPLIED",
        },
      })
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  }, 90_000);

  it("partial rollback skips entities changed after apply", async () => {
    const client = db();
    const seed = await seedLegacyTaxonomy();
    const manifestPath = join(tempDir!, "manifest-partial.json");
    const preview = await previewTaxonomyRestructure(client, {
      proposalPath: PROPOSAL,
      mappingPath: MAPPING,
      manifestPath,
      overwrite: true,
    });
    const applied = await applyTaxonomyRestructure(client, {
      manifestPath,
      confirm: preview.confirmationToken,
      actor: "test-actor",
    });

    await client.classification.update({
      where: { id: seed.appointments.id },
      data: { nameAr: "تعديل يدوي بعد التطبيق" },
    });

    const rolled = await rollbackTaxonomyRestructure(client, {
      runId: applied.runId,
      confirm: applied.rollbackToken,
      actor: "test-actor",
    });
    expect(rolled.status).toBe("PARTIALLY_ROLLED_BACK");
    expect(rolled.skipped).toBeGreaterThan(0);

    const appointments = await client.classification.findUniqueOrThrow({
      where: { id: seed.appointments.id },
    });
    expect(appointments.nameAr).toBe("تعديل يدوي بعد التطبيق");

    const skipped = await client.classificationTaxonomyRestructureItem.findMany({
      where: { runId: applied.runId, result: "ROLLBACK_SKIPPED" },
    });
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((i) => i.skipReason === "ENTITY_CHANGED_AFTER_APPLY")).toBe(true);
  }, 90_000);

  it("rejects creating a classification named like its category", async () => {
    const client = db();
    const category = await client.category.create({
      data: { nameAr: `فئة مطابقة-${crypto.randomUUID().slice(0, 6)}` },
    });
    await expect(
      createClassification(
        { categoryId: category.id, name: category.nameAr, actor: "test" },
        client as never
      )
    ).rejects.toBeInstanceOf(ClassificationManagementError);
    try {
      await createClassification(
        { categoryId: category.id, name: category.nameAr, actor: "test" },
        client as never
      );
    } catch (error) {
      expect((error as ClassificationManagementError).code).toBe(
        "CLASSIFICATION_NAME_EQUALS_CATEGORY_NAME"
      );
    }
  });
});
