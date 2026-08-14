import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLASSIFICATION_ASSIGNMENT_SOURCES } from "./classification-assignment";
import {
  AUDIT_ERROR_CODES,
  AUDIT_RESULTS,
  HistoricalClassificationAuditError,
  applyHistoricalClassificationAudit,
  previewHistoricalClassificationAudit,
  readAndValidateAuditManifest,
  rollbackHistoricalClassificationAudit,
  verifyHistoricalClassificationAudit,
} from "./historical-classification-audit-service";

let prisma: PrismaClient | undefined;
let testDirectory: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  testDirectory = mkdtempSync(join(tmpdir(), "cip-classification-audit-"));
  const databasePath = join(testDirectory, "audit.db");
  process.env.DATABASE_URL = `file:${databasePath}`;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
    stdio: "pipe",
  });
  prisma = new PrismaClient();
}, 60_000);

afterAll(async () => {
  try {
    await prisma?.$disconnect();
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (testDirectory) rmSync(testDirectory, { recursive: true, force: true });
  }
});

function db(): PrismaClient {
  if (!prisma) throw new Error("test database is not initialized");
  return prisma;
}

describe("historical classification audit SQLite workflow", () => {
  it("runs dry-run, guarded apply, verify, and concurrency-safe rollback without data loss", async () => {
    const client = db();
    const category = await client.category.create({
      data: { nameAr: "التوجية والارشاد" },
    });
    const wrong = await client.classification.create({
      data: { categoryId: category.id, nameAr: "-", keywords: [] },
    });
    const quran = await client.classification.create({
      data: {
        categoryId: category.id,
        nameAr: "القرآن والبرامج الدينية",
        keywords: ["أجزاء القرآن"],
      },
    });

    const originalPayload = {
      externalId: "audit-external-1",
      subject: "موضوع يجب ألا يتغير",
      description: "وصف يجب ألا يتغير",
      sourceDetail: "أجزاء القرآن",
    };
    const correctable = await client.complaint.create({
      data: {
        ...originalPayload,
        classificationId: wrong.id,
        categoryId: category.id,
        classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.LEGACY_UNKNOWN,
        classificationAssignedBy: "legacy-import",
      },
    });
    const second = await client.complaint.create({
      data: {
        externalId: "audit-external-2",
        subject: "سجل ثانٍ",
        description: "وصف ثانٍ",
        sourceDetail: "  أَجــزَاء   القُرآن  ",
        classificationId: wrong.id,
        categoryId: category.id,
        classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.LEGACY_UNKNOWN,
      },
    });
    const alreadyCorrect = await client.complaint.create({
      data: {
        externalId: "audit-external-3",
        subject: "سجل صحيح",
        description: "يبقى كما هو",
        sourceDetail: "أجزاء القرآن",
        classificationId: quran.id,
        categoryId: category.id,
        classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL,
      },
    });

    const countBefore = await client.complaint.count();
    const manifestPath = join(testDirectory!, "audit-manifest.json");
    const privateReviewPath = join(testDirectory!, "private-review.json");
    const dryRun = await previewHistoricalClassificationAudit(client, {
      manifestPath,
      privateReviewPath,
      overwrite: true,
    });
    expect(dryRun.counts[AUDIT_RESULTS.CORRECT_HIGH_CONFIDENCE]).toBe(2);
    expect(dryRun.counts[AUDIT_RESULTS.KEEP]).toBe(1);
    expect(await client.classificationAuditRun.count()).toBe(0);
    expect(await client.classificationAuditItem.count()).toBe(0);
    const manifestText = readFileSync(manifestPath, "utf8");
    expect(manifestText).not.toContain(originalPayload.subject);
    expect(manifestText).not.toContain(originalPayload.description);
    expect(manifestText).not.toContain(originalPayload.sourceDetail);
    expect(manifestText).not.toContain("complainantIdentifier");
    const manifest = readAndValidateAuditManifest(manifestPath);

    await expect(
      applyHistoricalClassificationAudit(client, {
        manifestPath,
        confirm: dryRun.confirmationToken,
      })
    ).rejects.toMatchObject({ code: AUDIT_ERROR_CODES.BACKUP_REQUIRED });

    await expect(
      applyHistoricalClassificationAudit(client, {
        manifestPath,
        confirm: dryRun.confirmationToken,
        createAndVerifyBackup: async () => {
          throw new Error("backup creation failed");
        },
      })
    ).rejects.toMatchObject({ code: AUDIT_ERROR_CODES.BACKUP_FAILED });
    await expect(
      applyHistoricalClassificationAudit(client, {
        manifestPath,
        confirm: dryRun.confirmationToken,
        createAndVerifyBackup: async () => {
          throw new Error("backup verification failed");
        },
      })
    ).rejects.toMatchObject({ code: AUDIT_ERROR_CODES.BACKUP_FAILED });
    expect(await client.classificationAuditRun.count()).toBe(0);
    expect(await client.complaint.count()).toBe(countBefore);

    const backupGuard = vi.fn(async () => ({
      backupName: "backup-test-verified",
      verified: true as const,
    }));
    const applied = await applyHistoricalClassificationAudit(client, {
      manifestPath,
      confirm: manifest.confirmationToken,
      actor: "historical-classification-cleanup",
      batchSize: 1,
      createAndVerifyBackup: backupGuard,
    });
    expect(backupGuard).toHaveBeenCalledTimes(1);
    expect(applied.status).toBe("APPLIED");
    expect(applied.appliedCount).toBe(2);
    expect(await client.complaint.count()).toBe(countBefore);

    const corrected = await client.complaint.findUniqueOrThrow({
      where: { id: correctable.id },
    });
    expect(corrected).toMatchObject({
      ...originalPayload,
      classificationId: quran.id,
      categoryId: category.id,
      classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_CORRECTION,
      classificationAssignedBy: "historical-classification-cleanup",
      classificationAssignmentRunId: null,
      version: correctable.version + 1,
    });
    expect(corrected.classificationTaxonomyFingerprint).toBe(manifest.taxonomyFingerprint);
    const correctAfter = await client.complaint.findUniqueOrThrow({
      where: { id: alreadyCorrect.id },
    });
    expect(correctAfter.version).toBe(alreadyCorrect.version);
    expect(correctAfter.classificationAssignmentSource).toBe(
      CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL
    );

    const correctionLogs = await client.auditLog.findMany({
      where: { action: "COMPLAINT_CLASSIFICATION_HISTORICALLY_CORRECTED" },
    });
    expect(correctionLogs).toHaveLength(2);
    const serializedLog = JSON.stringify(correctionLogs);
    expect(serializedLog).not.toContain(originalPayload.subject);
    expect(serializedLog).not.toContain(originalPayload.description);
    expect(serializedLog).not.toContain(originalPayload.sourceDetail);

    const verified = await verifyHistoricalClassificationAudit(client, { runId: applied.runId });
    expect(verified.ok).toBe(true);
    expect(verified.totalComplaintsBefore).toBe(countBefore);
    expect(verified.totalComplaintsAfter).toBe(countBefore);
    expect(verified.categoryClassificationMismatchCountAfter).toBe(0);

    // A newer manual edit must not be overwritten by rollback.
    await client.complaint.update({
      where: { id: second.id },
      data: {
        subject: "تعديل يدوي أحدث",
        version: { increment: 1 },
      },
    });
    const rolledBack = await rollbackHistoricalClassificationAudit(client, {
      runId: applied.runId,
      confirm: applied.rollbackToken,
      actor: "historical-classification-cleanup",
      batchSize: 1,
    });
    expect(rolledBack.status).toBe("PARTIALLY_ROLLED_BACK");
    expect(rolledBack.rolledBackCount).toBe(1);
    expect(rolledBack.skippedCount).toBe(1);
    expect(await client.complaint.count()).toBe(countBefore);

    const restored = await client.complaint.findUniqueOrThrow({
      where: { id: correctable.id },
    });
    expect(restored).toMatchObject({
      ...originalPayload,
      classificationId: wrong.id,
      categoryId: category.id,
      classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.LEGACY_UNKNOWN,
      classificationAssignedBy: "legacy-import",
    });
    const newer = await client.complaint.findUniqueOrThrow({ where: { id: second.id } });
    expect(newer.classificationId).toBe(quran.id);
    expect(newer.subject).toBe("تعديل يدوي أحدث");
    const skippedItem = await client.classificationAuditItem.findFirstOrThrow({
      where: { runId: applied.runId, complaintId: second.id },
    });
    expect(skippedItem.skipReason).toBe("ROLLBACK_SKIPPED_VERSION_CHANGED");
  });

  it("refuses an old manifest when a target complaint changes", async () => {
    const client = db();
    const wrong = await client.classification.findFirstOrThrow({ where: { nameAr: "-" } });
    const category = await client.category.findFirstOrThrow({
      where: { nameAr: "التوجية والارشاد" },
    });
    const candidate = await client.complaint.create({
      data: {
        subject: "سباق نسخة",
        sourceDetail: "أجزاء القرآن",
        classificationId: wrong.id,
        categoryId: category.id,
        classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.LEGACY_UNKNOWN,
      },
    });
    const manifestPath = join(testDirectory!, "race-manifest.json");
    const dryRun = await previewHistoricalClassificationAudit(client, {
      manifestPath,
      overwrite: true,
    });
    await client.complaint.update({
      where: { id: candidate.id },
      data: { version: { increment: 1 } },
    });
    await expect(
      applyHistoricalClassificationAudit(client, {
        manifestPath,
        confirm: dryRun.confirmationToken,
        createAndVerifyBackup: async () => ({ backupName: "should-not-run", verified: true }),
      })
    ).rejects.toBeInstanceOf(HistoricalClassificationAuditError);
    await expect(
      applyHistoricalClassificationAudit(client, {
        manifestPath,
        confirm: dryRun.confirmationToken,
        createAndVerifyBackup: async () => ({ backupName: "should-not-run", verified: true }),
      })
    ).rejects.toMatchObject({ code: AUDIT_ERROR_CODES.DATABASE_CHANGED });
  });
});
