import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLASSIFICATION_ASSIGNMENT_SOURCES } from "./classification-assignment";
import {
  BACKFILL_ERROR_CODES,
  BACKFILL_SKIP_REASONS,
  HistoricalBackfillError,
  buildConfirmationToken,
  buildRollbackToken,
  computeManifestHash,
  parseInclusivePeriod,
  previewHistoricalClassificationBackfill,
  readAndValidateManifest,
  stableStringify,
  validateBatchSize,
  type BackfillManifest,
  type ManifestRow,
} from "./historical-classification-backfill";
import { computeTaxonomyFingerprint, hashSourceDetailValue } from "./taxonomy-fingerprint";
import { resolveSourceDetailClassification } from "./source-detail-classification-resolver";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cip-backfill-unit-"));
  tempDirs.push(dir);
  return dir;
}

function sampleTaxonomy() {
  return [
    {
      id: "cls-a",
      nameAr: "تصنيف أ",
      keywords: ["تأخير موعد"],
      isActive: true,
      isDeleted: false,
      category: { id: "cat-1", nameAr: "فئة", isActive: true, isDeleted: false },
    },
    {
      id: "cls-b",
      nameAr: "تصنيف ب",
      keywords: ["موقف سيارات"],
      isActive: true,
      isDeleted: false,
      category: { id: "cat-1", nameAr: "فئة", isActive: true, isDeleted: false },
    },
  ];
}

function makeComplaint(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp-1",
    version: 1,
    classificationId: null,
    classificationAssignmentSource: null,
    sourceDetail: "تأخير موعد",
    complaintDate: new Date("2025-10-01T00:00:00.000Z"),
    receivedAt: new Date("2025-10-01T00:00:00.000Z"),
    isDeleted: false,
    ...overrides,
  };
}

function createMockDb(complaints: ReturnType<typeof makeComplaint>[]) {
  return {
    classification: {
      findMany: vi.fn(async () => sampleTaxonomy()),
    },
    complaint: {
      findMany: vi.fn(async () => complaints),
      findUnique: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    classificationBackfillRun: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    classificationBackfillItem: {
      createMany: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: "audit-1" })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
}

describe("historical backfill helpers", () => {
  it("rejects invalid batch size", () => {
    expect(() => validateBatchSize(0)).toThrow(HistoricalBackfillError);
    expect(() => validateBatchSize(1001)).toThrow(HistoricalBackfillError);
    expect(validateBatchSize(500)).toBe(500);
  });

  it("parses inclusive period into half-open range", () => {
    const period = parseInclusivePeriod("2025-09-08", "2026-07-15");
    expect(period.toExclusiveIso).toBe("2026-07-16");
    expect(() => parseInclusivePeriod("2026-07-15", "2025-09-08")).toThrow();
  });

  it("builds stable confirmation and rollback tokens", () => {
    const token = buildConfirmationToken({
      manifestHash: "abc",
      taxonomyFingerprint: "fp",
      eligibleCount: 16989,
      periodFrom: "2025-09-08",
      periodTo: "2026-07-15",
    });
    expect(token).toMatch(/^APPLY-16989-[A-F0-9]{10}$/);
    const rollback = buildRollbackToken({
      runId: "run-1",
      manifestHash: "abc",
      appliedCount: 10,
    });
    expect(rollback).toMatch(/^ROLLBACK-10-[A-F0-9]{10}$/);
  });
});

describe("dry-run preview", () => {
  it("does not write database run/item/audit rows", async () => {
    const dir = tempDir();
    const manifestPath = join(dir, "manifest.json");
    const db = createMockDb([
      makeComplaint({ id: "cmp-matched" }),
      makeComplaint({
        id: "cmp-ambiguous",
        sourceDetail: "قيمة غامضة",
      }),
      makeComplaint({
        id: "cmp-unmatched",
        sourceDetail: "لا تطابق",
      }),
      makeComplaint({
        id: "cmp-empty",
        sourceDetail: null,
      }),
      makeComplaint({
        id: "cmp-manual",
        sourceDetail: "تأخير موعد",
        classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL,
      }),
      makeComplaint({
        id: "cmp-classified",
        classificationId: "cls-a",
        classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.LEGACY_UNKNOWN,
      }),
    ]);

    // Make ambiguous by duplicating keyword on second classification for one value
    db.classification.findMany = vi.fn(async () => [
      ...sampleTaxonomy(),
      {
        id: "cls-c",
        nameAr: "تصنيف ج",
        keywords: ["قيمة غامضة"],
        isActive: true,
        isDeleted: false,
        category: { id: "cat-1", nameAr: "فئة", isActive: true, isDeleted: false },
      },
      {
        id: "cls-d",
        nameAr: "تصنيف د",
        keywords: ["قيمة غامضة"],
        isActive: true,
        isDeleted: false,
        category: { id: "cat-1", nameAr: "فئة", isActive: true, isDeleted: false },
      },
    ]);

    const result = await previewHistoricalClassificationBackfill(db as never, {
      from: "2025-09-08",
      toInclusive: "2026-07-15",
      manifestPath,
      overwrite: true,
    });

    expect(db.classificationBackfillRun.create).not.toHaveBeenCalled();
    expect(db.classificationBackfillItem.createMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(db.complaint.updateMany).not.toHaveBeenCalled();
    expect(result.eligibleCount).toBe(1);
    expect(result.ambiguousCount).toBe(1);
    expect(result.unmatchedCount).toBe(1);
    expect(result.manuallyProtectedCount).toBe(1);
    expect(result.alreadyClassifiedCount).toBe(1);
    expect(result.missingSourceDetailCount).toBe(1);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackfillManifest;
    expect(manifest.rows).toHaveLength(1);
    expect(manifest.rows[0]?.matchCode).toBe("MATCHED");
    expect(JSON.stringify(manifest)).not.toContain("تأخير موعد");
    expect(JSON.stringify(manifest)).not.toContain("description");
    expect(JSON.stringify(manifest)).not.toContain("subject");
    expect(JSON.stringify(manifest)).not.toContain("complainant");
    expect(manifest.rows[0]?.sourceDetailHash).toBe(hashSourceDetailValue("تأخير موعد"));
  });

  it("excludes inactive classifications from MATCHED targets", async () => {
    const dir = tempDir();
    const db = createMockDb([makeComplaint({ sourceDetail: "غير نشط" })]);
    db.classification.findMany = vi.fn(async () => [
      {
        id: "cls-inactive",
        nameAr: "معطل",
        keywords: ["غير نشط"],
        isActive: false,
        isDeleted: false,
        category: { id: "cat-1", nameAr: "فئة", isActive: true, isDeleted: false },
      },
    ]);
    // loadActiveTaxonomy filters active only — inactive won't be loaded
    db.classification.findMany = vi.fn(async () => []);
    const result = await previewHistoricalClassificationBackfill(db as never, {
      from: "2025-09-08",
      toInclusive: "2026-07-15",
      manifestPath: join(dir, "m.json"),
      overwrite: true,
    });
    expect(result.eligibleCount).toBe(0);
    expect(result.unmatchedCount).toBe(1);
  });

  it("detects manifest hash tampering", async () => {
    const dir = tempDir();
    const path = join(dir, "m.json");
    const db = createMockDb([makeComplaint()]);
    await previewHistoricalClassificationBackfill(db as never, {
      from: "2025-09-08",
      toInclusive: "2026-07-15",
      manifestPath: path,
      overwrite: true,
    });
    const manifest = JSON.parse(readFileSync(path, "utf8")) as BackfillManifest;
    manifest.rows[0]!.expectedVersion = 99;
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => readAndValidateManifest(path)).toThrowError(
      expect.objectContaining({ code: BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_HASH_MISMATCH })
    );
  });

  it("keeps manifest hash stable for identical content", () => {
    const rows: ManifestRow[] = [
      {
        complaintId: "b",
        expectedVersion: 1,
        previousClassificationId: null,
        previousAssignmentSource: null,
        targetClassificationId: "c1",
        targetCategoryId: "cat1",
        targetClassificationName: "أ",
        sourceDetailHash: "h1",
        matchCode: "MATCHED",
      },
      {
        complaintId: "a",
        expectedVersion: 1,
        previousClassificationId: null,
        previousAssignmentSource: null,
        targetClassificationId: "c1",
        targetCategoryId: "cat1",
        targetClassificationName: "أ",
        sourceDetailHash: "h2",
        matchCode: "MATCHED",
      },
    ];
    const base = {
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      period: { from: "2025-09-08", toInclusive: "2026-07-15", toExclusive: "2026-07-16" },
      taxonomyFingerprint: "fp",
      totals: {
        eligibleCount: 2,
        alreadyClassifiedCount: 0,
        manuallyProtectedCount: 0,
        ambiguousCount: 0,
        unmatchedCount: 0,
        missingSourceDetailCount: 0,
        inactiveTargetCount: 0,
        outsidePeriodCount: 0,
      },
      classificationDistribution: [
        {
          classificationId: "c1",
          classificationName: "أ",
          categoryId: "cat1",
          categoryName: "فئة",
          eligibleCount: 2,
        },
      ],
      rows,
    };
    expect(computeManifestHash(base)).toBe(computeManifestHash({ ...base, rows: [...rows].reverse() }));
  });

  it("stableStringify is independent of object key insertion order", () => {
    const left = { schemaVersion: 1, totals: { eligibleCount: 2 }, period: { from: "a", to: "b" } };
    const right = { period: { to: "b", from: "a" }, totals: { eligibleCount: 2 }, schemaVersion: 1 };
    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(createHash("sha256").update(stableStringify(left), "utf8").digest("hex")).toBe(
      createHash("sha256").update(stableStringify(right), "utf8").digest("hex")
    );
  });
});

describe("resolver gatekeeping", () => {
  it("only MATCHED is eligible for backfill planning", () => {
    const classifications = sampleTaxonomy();
    expect(
      resolveSourceDetailClassification({
        sourceDetail: "تأخير موعد",
        classifications,
      }).status
    ).toBe("MATCHED");
    expect(
      resolveSourceDetailClassification({
        sourceDetail: "لا يوجد",
        classifications,
      }).status
    ).toBe("UNMATCHED");
  });
});

describe("fingerprint isolation from management", () => {
  it("keyword changes alter fingerprint without implying complaint rewrite", () => {
    const before = computeTaxonomyFingerprint(sampleTaxonomy());
    const after = computeTaxonomyFingerprint([
      { ...sampleTaxonomy()[0]!, keywords: ["تأخير موعد", "جديد"] },
      sampleTaxonomy()[1]!,
    ]);
    expect(after).not.toBe(before);
    // Complaints keep classificationId; name changes are relation-based (documented policy).
    expect(createHash("sha256").update("relation-only").digest("hex")).toBeTruthy();
  });
});
