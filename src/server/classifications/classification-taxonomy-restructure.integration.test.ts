import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient, ComplaintStatus, ComplaintPriority } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyTaxonomyRestructure,
  previewTaxonomyRestructure,
  rollbackTaxonomyRestructure,
  verifyTaxonomyRestructure,
  TaxonomyRestructureError,
  RESTRUCTURE_ERROR_CODES,
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
  it("dry-run → apply → verify → rollback preserves ids and does not classify unclassified", async () => {
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

    // Dry-run must not write taxonomy changes.
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

    // Fingerprint gate after preview mutation.
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

    // Fresh seed for rollback path (re-preview/apply after intrusion).
    const seed2 = await seedLegacyTaxonomy();
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
    const rolled = await rollbackTaxonomyRestructure(client, {
      runId: applied2.runId,
      confirm: applied2.rollbackToken,
      actor: "test-actor",
    });
    expect(["ROLLED_BACK", "PARTIALLY_ROLLED_BACK"]).toContain(rolled.status);

    const appointmentsAfter = await client.classification.findUniqueOrThrow({
      where: { id: seed2.appointments.id },
    });
    expect(appointmentsAfter.nameAr).toBe("المواعيد");
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
