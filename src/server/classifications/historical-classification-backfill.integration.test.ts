import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplaintPriority, ComplaintStatus, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLASSIFICATION_ASSIGNMENT_SOURCES } from "./classification-assignment";
import {
  BACKFILL_ERROR_CODES,
  BACKFILL_ITEM_RESULTS,
  BACKFILL_RUN_STATUSES,
  HistoricalBackfillError,
  applyHistoricalClassificationBackfill,
  buildRollbackToken,
  previewHistoricalClassificationBackfill,
  readAndValidateManifest,
  rollbackHistoricalClassificationBackfill,
  verifyHistoricalClassificationBackfill,
} from "./historical-classification-backfill";
import {
  createCategory,
  createClassification,
  updateClassification,
} from "./classification-management-service";

let prisma: PrismaClient | undefined;
let tempDir: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  tempDir = mkdtempSync(join(tmpdir(), "cip-hist-backfill-"));
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

async function seedComplaint(input: {
  id?: string;
  subject: string;
  sourceDetail?: string | null;
  classificationId?: string | null;
  classificationAssignmentSource?: string | null;
  complaintDate?: Date;
}) {
  return db().complaint.create({
    data: {
      id: input.id,
      subject: input.subject,
      description: "وصف داخلي للاختبار",
      sourceDetail: input.sourceDetail ?? null,
      classificationId: input.classificationId ?? null,
      classificationAssignmentSource: input.classificationAssignmentSource ?? null,
      status: ComplaintStatus.NEW,
      priority: ComplaintPriority.MEDIUM,
      severity: ComplaintPriority.MEDIUM,
      complaintDate: input.complaintDate ?? new Date("2025-10-15T00:00:00.000Z"),
      receivedAt: input.complaintDate ?? new Date("2025-10-15T00:00:00.000Z"),
      complainantName: "اسم محمي",
      complainantPhone: "0500000000",
    },
  });
}

describe("historical classification backfill SQLite integration", () => {
  it("runs dry-run → apply → verify → rollback with protections", async () => {
    const client = db();
    const category = await createCategory(
      { name: `فئة-خلفية-${crypto.randomUUID().slice(0, 8)}`, actor: "integ" },
      client as never
    );
    const classificationA = await createClassification(
      {
        categoryId: category.id,
        name: "تصنيف خلفية أ",
        keywords: ["تأخير موعد"],
        actor: "integ",
      },
      client as never
    );
    const classificationB = await createClassification(
      {
        categoryId: category.id,
        name: "تصنيف خلفية ب",
        keywords: ["مواقف السيارات"],
        actor: "integ",
      },
      client as never
    );

    const eligible1 = await seedComplaint({
      subject: "غير مصنفة 1",
      sourceDetail: "تأخير موعد",
    });
    const eligible2 = await seedComplaint({
      subject: "غير مصنفة 2",
      sourceDetail: "مواقف السيارات",
    });
    const legacy = await seedComplaint({
      subject: "قديمة مصنفة",
      sourceDetail: "تأخير موعد",
      classificationId: classificationA.id,
      // migration would set LEGACY_UNKNOWN; simulate already migrated state
      classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.LEGACY_UNKNOWN,
    });
    const manualClassified = await seedComplaint({
      subject: "يدوية",
      sourceDetail: "تأخير موعد",
      classificationId: classificationB.id,
      classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL,
    });
    const manualProtected = await seedComplaint({
      subject: "محمية يدويًا بدون تصنيف",
      sourceDetail: "تأخير موعد",
      classificationId: null,
      classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL,
    });

    // Migration semantics: classified + null source → LEGACY_UNKNOWN
    const preLegacy = await seedComplaint({
      subject: "legacy candidate",
      sourceDetail: "x",
      classificationId: classificationA.id,
      classificationAssignmentSource: null,
    });
    await client.$executeRawUnsafe(
      `UPDATE "Complaint" SET "classificationAssignmentSource" = 'LEGACY_UNKNOWN' WHERE "classificationId" IS NOT NULL AND "classificationAssignmentSource" IS NULL`
    );
    const afterLegacy = await client.complaint.findUniqueOrThrow({ where: { id: preLegacy.id } });
    expect(afterLegacy.classificationAssignmentSource).toBe("LEGACY_UNKNOWN");
    expect(afterLegacy.classificationId).toBe(classificationA.id);
    const stillNull = await client.complaint.findUniqueOrThrow({ where: { id: eligible1.id } });
    expect(stillNull.classificationAssignmentSource).toBeNull();

    const manifestPath = join(tempDir!, "classification-backfill-manifest.json");
    const dryRun = await previewHistoricalClassificationBackfill(client, {
      from: "2025-09-08",
      toInclusive: "2026-07-15",
      manifestPath,
      overwrite: true,
    });

    expect(dryRun.eligibleCount).toBeGreaterThanOrEqual(2);
    expect(dryRun.manuallyProtectedCount).toBeGreaterThanOrEqual(1);
    const runCountBefore = await client.classificationBackfillRun.count();
    expect(runCountBefore).toBe(0);
    const auditBefore = await client.auditLog.count();

    const manifest = readAndValidateManifest(manifestPath);
    expect(JSON.stringify(manifest)).not.toContain("تأخير موعد");
    expect(JSON.stringify(manifest)).not.toContain("اسم محمي");
    expect(JSON.stringify(manifest)).not.toContain("0500000000");
    expect(manifest.rows.some((r) => r.complaintId === eligible1.id)).toBe(true);
    expect(manifest.rows.some((r) => r.complaintId === manualProtected.id)).toBe(false);

    await expect(
      applyHistoricalClassificationBackfill(client, {
        manifestPath,
        actor: "integ",
      })
    ).rejects.toMatchObject({ code: BACKFILL_ERROR_CODES.BACKFILL_CONFIRMATION_REQUIRED });

    await expect(
      applyHistoricalClassificationBackfill(client, {
        manifestPath,
        confirm: "APPLY-0-BADTOKEN00",
        actor: "integ",
      })
    ).rejects.toMatchObject({ code: BACKFILL_ERROR_CODES.BACKFILL_CONFIRMATION_INVALID });

    const applied = await applyHistoricalClassificationBackfill(client, {
      manifestPath,
      confirm: dryRun.confirmationToken,
      batchSize: 2,
      actor: "integ",
    });
    expect(applied.status).toBe(BACKFILL_RUN_STATUSES.APPLIED);
    expect(applied.appliedCount).toBeGreaterThanOrEqual(2);

    const c1 = await client.complaint.findUniqueOrThrow({ where: { id: eligible1.id } });
    expect(c1.classificationId).toBe(classificationA.id);
    expect(c1.classificationAssignmentSource).toBe(
      CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL
    );
    expect(c1.classificationAssignmentRunId).toBe(applied.runId);

    const legacyAfter = await client.complaint.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(legacyAfter.classificationId).toBe(classificationA.id);
    expect(legacyAfter.classificationAssignmentSource).toBe("LEGACY_UNKNOWN");

    const manualAfter = await client.complaint.findUniqueOrThrow({
      where: { id: manualClassified.id },
    });
    expect(manualAfter.classificationId).toBe(classificationB.id);
    expect(manualAfter.classificationAssignmentSource).toBe("MANUAL");

    const protectedAfter = await client.complaint.findUniqueOrThrow({
      where: { id: manualProtected.id },
    });
    expect(protectedAfter.classificationId).toBeNull();
    expect(protectedAfter.classificationAssignmentSource).toBe("MANUAL");

    const items = await client.classificationBackfillItem.findMany({
      where: { runId: applied.runId },
    });
    expect(items.every((i) => i.result === BACKFILL_ITEM_RESULTS.APPLIED || i.result === BACKFILL_ITEM_RESULTS.SKIPPED)).toBe(
      true
    );
    expect(items.some((i) => (i as { sourceDetail?: string }).sourceDetail != null)).toBe(false);

    const auditAfter = await client.auditLog.count();
    expect(auditAfter).toBeGreaterThan(auditBefore);
    const started = await client.auditLog.findFirst({
      where: { action: "CLASSIFICATION_HISTORICAL_BACKFILL_STARTED" },
    });
    expect(started).toBeTruthy();
    expect(JSON.stringify(started?.metadata)).not.toContain("اسم محمي");

    await expect(
      applyHistoricalClassificationBackfill(client, {
        manifestPath,
        confirm: dryRun.confirmationToken,
        actor: "integ",
      })
    ).rejects.toMatchObject({ code: BACKFILL_ERROR_CODES.BACKFILL_ALREADY_APPLIED });

    // Manual change after apply — must not be rolled back
    await client.complaint.update({
      where: { id: eligible2.id },
      data: {
        classificationId: classificationA.id,
        classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL,
        classificationAssignedBy: "admin",
        classificationAssignedAt: new Date(),
        classificationAssignmentRunId: null,
        classificationTaxonomyFingerprint: null,
        version: { increment: 1 },
      },
    });

    const verified = await verifyHistoricalClassificationBackfill(client, {
      runId: applied.runId,
    });
    // eligible2 drifted → verify should fail applied invariants
    expect(verified.ok).toBe(false);

    // Keyword change does not rewrite complaints
    const beforeKeywordChange = await client.complaint.findUniqueOrThrow({
      where: { id: eligible1.id },
    });
    await updateClassification(
      classificationA.id,
      {
        keywords: ["تأخير موعد", "كلمة إضافية"],
        actor: "integ",
      },
      client as never
    );
    const afterKeywordChange = await client.complaint.findUniqueOrThrow({
      where: { id: eligible1.id },
    });
    expect(afterKeywordChange.classificationId).toBe(beforeKeywordChange.classificationId);
    expect(afterKeywordChange.classificationAssignmentSource).toBe(
      beforeKeywordChange.classificationAssignmentSource
    );
    expect(afterKeywordChange.version).toBe(beforeKeywordChange.version);

    // Name change reflects via relation without rewriting Complaint row classificationId
    await updateClassification(
      classificationA.id,
      { name: "تصنيف خلفية أ محدّث", actor: "integ" },
      client as never
    );
    const withRelation = await client.complaint.findUniqueOrThrow({
      where: { id: eligible1.id },
      include: { classification: true },
    });
    expect(withRelation.classificationId).toBe(classificationA.id);
    expect(withRelation.classification?.nameAr).toBe("تصنيف خلفية أ محدّث");

    // Taxonomy changed → new apply of old manifest must fail
    await expect(
      applyHistoricalClassificationBackfill(client, {
        manifestPath,
        confirm: dryRun.confirmationToken,
        actor: "integ",
      })
    ).rejects.toBeInstanceOf(HistoricalBackfillError);

    const rollbackToken = buildRollbackToken({
      runId: applied.runId,
      manifestHash: applied.manifestHash,
      appliedCount: applied.appliedCount,
    });
    const rolled = await rollbackHistoricalClassificationBackfill(client, {
      runId: applied.runId,
      confirm: rollbackToken,
      actor: "integ",
    });
    expect([
      BACKFILL_RUN_STATUSES.ROLLED_BACK,
      BACKFILL_RUN_STATUSES.PARTIALLY_ROLLED_BACK,
    ]).toContain(rolled.status);

    const eligible1AfterRollback = await client.complaint.findUniqueOrThrow({
      where: { id: eligible1.id },
    });
    expect(eligible1AfterRollback.classificationId).toBeNull();
    expect(eligible1AfterRollback.classificationAssignmentSource).toBeNull();

    const eligible2AfterRollback = await client.complaint.findUniqueOrThrow({
      where: { id: eligible2.id },
    });
    expect(eligible2AfterRollback.classificationId).toBe(classificationA.id);
    expect(eligible2AfterRollback.classificationAssignmentSource).toBe("MANUAL");

    const legacyFinal = await client.complaint.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(legacyFinal.classificationId).toBe(classificationA.id);
    expect(legacyFinal.classificationAssignmentSource).toBe("LEGACY_UNKNOWN");
  }, 120_000);

  it("skips version and sourceDetail changes during apply", async () => {
    const client = db();
    const category = await createCategory(
      { name: `فئة-تخطي-${crypto.randomUUID().slice(0, 8)}`, actor: "integ" },
      client as never
    );
    await createClassification(
      {
        categoryId: category.id,
        name: `تصنيف تخطي ${crypto.randomUUID().slice(0, 6)}`,
        keywords: [`كلمة-تخطي-${crypto.randomUUID().slice(0, 6)}`],
        actor: "integ",
      },
      client as never
    );
    // Use unique keyword from last created classification
    const classifications = await client.classification.findMany({
      where: { categoryId: category.id },
      include: { category: true },
    });
    const cls = classifications[0]!;
    const keyword = (cls.keywords as string[])[0]!;

    const versionChanged = await seedComplaint({
      subject: "version",
      sourceDetail: keyword,
    });
    const detailChanged = await seedComplaint({
      subject: "detail",
      sourceDetail: keyword,
    });

    const manifestPath = join(tempDir!, "skip-manifest.json");
    const dry = await previewHistoricalClassificationBackfill(client, {
      from: "2025-09-08",
      toInclusive: "2026-07-15",
      manifestPath,
      overwrite: true,
    });
    expect(dry.eligibleCount).toBeGreaterThanOrEqual(2);

    await client.complaint.update({
      where: { id: versionChanged.id },
      data: { subject: "touched", version: { increment: 1 } },
    });
    await client.complaint.update({
      where: { id: detailChanged.id },
      data: { sourceDetail: `${keyword}-changed` },
    });

    const result = await applyHistoricalClassificationBackfill(client, {
      manifestPath,
      confirm: dry.confirmationToken,
      actor: "integ",
    });
    expect(result.skippedCount).toBeGreaterThanOrEqual(2);

    const items = await client.classificationBackfillItem.findMany({
      where: { runId: result.runId, complaintId: { in: [versionChanged.id, detailChanged.id] } },
    });
    const reasons = items.map((i) => i.skipReason);
    expect(reasons).toContain("VERSION_CHANGED");
    expect(reasons).toContain("SOURCE_DETAIL_CHANGED");

    const stillUnclassified = await client.complaint.findMany({
      where: { id: { in: [versionChanged.id, detailChanged.id] } },
    });
    expect(stillUnclassified.every((c) => c.classificationId == null)).toBe(true);
  }, 60_000);

  it("rejects empty period edge and processes batches", async () => {
    const client = db();
    const manifestPath = join(tempDir!, "empty-period.json");
    const dry = await previewHistoricalClassificationBackfill(client, {
      from: "2010-01-01",
      toInclusive: "2010-01-02",
      manifestPath,
      overwrite: true,
    });
    expect(dry.eligibleCount).toBe(0);
    expect(readFileSync(manifestPath, "utf8")).toContain('"rows": []');
  });
});
