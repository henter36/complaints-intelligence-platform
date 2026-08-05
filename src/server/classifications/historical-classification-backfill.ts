import { createHash } from "node:crypto";
import { createWriteStream, renameSync, existsSync, chmodSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAuditLog, AUDIT_ACTOR_SYSTEM } from "@/server/audit/audit-log-service";
import {
  CLASSIFICATION_ASSIGNMENT_SOURCES,
  buildClassificationAssignmentMetadata,
  isManuallyProtectedUnclassified,
} from "./classification-assignment";
import {
  resolveSourceDetailClassification,
  type SourceDetailClassificationCandidate,
} from "./source-detail-classification-resolver";
import { compareCodeUnits } from "./canonical-string-order";
import {
  computeTaxonomyFingerprint,
  hashSourceDetailValue,
  type TaxonomyFingerprintClassification,
} from "./taxonomy-fingerprint";

export const BACKFILL_SCHEMA_VERSION = 1;

export const BACKFILL_OPERATIONS = {
  APPLY: "APPLY",
  ROLLBACK: "ROLLBACK",
} as const;

export const BACKFILL_RUN_STATUSES = {
  APPLYING: "APPLYING",
  APPLIED: "APPLIED",
  PARTIALLY_APPLIED: "PARTIALLY_APPLIED",
  FAILED: "FAILED",
  VERIFY_FAILED: "VERIFY_FAILED",
  ROLLING_BACK: "ROLLING_BACK",
  ROLLED_BACK: "ROLLED_BACK",
  PARTIALLY_ROLLED_BACK: "PARTIALLY_ROLLED_BACK",
} as const;

export type BackfillRunStatus =
  (typeof BACKFILL_RUN_STATUSES)[keyof typeof BACKFILL_RUN_STATUSES];

export const BACKFILL_ITEM_RESULTS = {
  PLANNED: "PLANNED",
  APPLIED: "APPLIED",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
  ROLLED_BACK: "ROLLED_BACK",
  ROLLBACK_SKIPPED: "ROLLBACK_SKIPPED",
} as const;

export const BACKFILL_SKIP_REASONS = {
  ALREADY_CLASSIFIED: "ALREADY_CLASSIFIED",
  MANUALLY_PROTECTED: "MANUALLY_PROTECTED",
  AMBIGUOUS: "AMBIGUOUS",
  UNMATCHED: "UNMATCHED",
  MISSING_SOURCE_DETAIL: "MISSING_SOURCE_DETAIL",
  INACTIVE_CLASSIFICATION: "INACTIVE_CLASSIFICATION",
  VERSION_CHANGED: "VERSION_CHANGED",
  SOURCE_DETAIL_CHANGED: "SOURCE_DETAIL_CHANGED",
  DELETED_AFTER_PREVIEW: "DELETED_AFTER_PREVIEW",
  TARGET_CHANGED: "TARGET_CHANGED",
  OUTSIDE_PERIOD: "OUTSIDE_PERIOD",
  CATEGORY_CLASSIFICATION_MISMATCH: "CATEGORY_CLASSIFICATION_MISMATCH",
  ROLLBACK_SKIPPED_VERSION_CHANGED: "ROLLBACK_SKIPPED_VERSION_CHANGED",
  ROLLBACK_SKIPPED_MANUAL_CHANGE: "ROLLBACK_SKIPPED_MANUAL_CHANGE",
  ROLLBACK_SKIPPED_CLASSIFICATION_CHANGED: "ROLLBACK_SKIPPED_CLASSIFICATION_CHANGED",
  ROLLBACK_SKIPPED_DELETED: "ROLLBACK_SKIPPED_DELETED",
} as const;

export type BackfillSkipReason =
  (typeof BACKFILL_SKIP_REASONS)[keyof typeof BACKFILL_SKIP_REASONS];

export const BACKFILL_ERROR_CODES = {
  BACKFILL_MANIFEST_REQUIRED: "BACKFILL_MANIFEST_REQUIRED",
  BACKFILL_MANIFEST_NOT_FOUND: "BACKFILL_MANIFEST_NOT_FOUND",
  BACKFILL_MANIFEST_INVALID: "BACKFILL_MANIFEST_INVALID",
  BACKFILL_MANIFEST_HASH_MISMATCH: "BACKFILL_MANIFEST_HASH_MISMATCH",
  BACKFILL_CONFIRMATION_REQUIRED: "BACKFILL_CONFIRMATION_REQUIRED",
  BACKFILL_CONFIRMATION_INVALID: "BACKFILL_CONFIRMATION_INVALID",
  CLASSIFICATION_TAXONOMY_CHANGED: "CLASSIFICATION_TAXONOMY_CHANGED",
  BACKFILL_SCHEMA_VERSION_UNSUPPORTED: "BACKFILL_SCHEMA_VERSION_UNSUPPORTED",
  BACKFILL_ALREADY_APPLIED: "BACKFILL_ALREADY_APPLIED",
  BACKFILL_RUN_NOT_FOUND: "BACKFILL_RUN_NOT_FOUND",
  BACKFILL_INVALID_BATCH_SIZE: "BACKFILL_INVALID_BATCH_SIZE",
  BACKFILL_PERIOD_REQUIRED: "BACKFILL_PERIOD_REQUIRED",
  BACKFILL_INVALID_PERIOD: "BACKFILL_INVALID_PERIOD",
  BACKFILL_MANIFEST_EXISTS: "BACKFILL_MANIFEST_EXISTS",
  BACKFILL_PARTIAL_NEEDS_EXPLICIT_RESUME: "BACKFILL_PARTIAL_NEEDS_EXPLICIT_RESUME",
  BACKFILL_VERIFY_FAILED: "BACKFILL_VERIFY_FAILED",
  CURRENT_TAXONOMY_DIFFERS_FROM_APPLIED_FINGERPRINT:
    "CURRENT_TAXONOMY_DIFFERS_FROM_APPLIED_FINGERPRINT",
} as const;

export class HistoricalBackfillError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HistoricalBackfillError";
  }
}

export type BackfillDb = PrismaClient;

export type ManifestRow = {
  complaintId: string;
  expectedVersion: number;
  previousClassificationId: string | null;
  previousCategoryId?: string | null;
  previousAssignmentSource: string | null;
  targetClassificationId: string;
  targetCategoryId: string;
  targetClassificationName: string;
  sourceDetailHash: string;
  matchCode: "MATCHED";
};

export type ClassificationDistributionEntry = {
  classificationId: string;
  classificationName: string;
  categoryId: string;
  categoryName: string;
  eligibleCount: number;
};

export type BackfillManifest = {
  schemaVersion: number;
  generatedAt: string;
  period: { from: string; toInclusive: string; toExclusive: string };
  taxonomyFingerprint: string;
  totals: {
    eligibleCount: number;
    alreadyClassifiedCount: number;
    manuallyProtectedCount: number;
    ambiguousCount: number;
    unmatchedCount: number;
    missingSourceDetailCount: number;
    inactiveTargetCount: number;
    outsidePeriodCount: number;
  };
  classificationDistribution: ClassificationDistributionEntry[];
  rows: ManifestRow[];
  manifestHash: string;
  confirmationToken: string;
};

export type DryRunResult = {
  mode: "dry-run";
  manifestPath: string;
  manifestHash: string;
  taxonomyFingerprint: string;
  eligibleCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  manuallyProtectedCount: number;
  alreadyClassifiedCount: number;
  missingSourceDetailCount: number;
  inactiveTargetCount: number;
  classificationDistribution: ClassificationDistributionEntry[];
  confirmationToken: string;
};

export type ApplyResult = {
  mode: "apply";
  runId: string;
  status: BackfillRunStatus;
  manifestHash: string;
  taxonomyFingerprint: string;
  plannedCount: number;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  confirmationToken: string;
  rollbackToken: string;
};

export type VerifyResult = {
  mode: "verify";
  runId: string;
  ok: boolean;
  status: string;
  invariants: Array<{ code: string; ok: boolean; detail?: string }>;
  remainingUnclassifiedInPeriod: number;
  taxonomyNote?: string;
};

export type RollbackResult = {
  mode: "rollback";
  runId: string;
  originalRunId: string;
  status: BackfillRunStatus;
  rolledBackCount: number;
  skippedCount: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;

export function serializeStableEntry(key: string, value: unknown): string {
  return JSON.stringify(key) + ":" + stableStringify(value);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(compareCodeUnits);
  return "{" + keys.map((key) => serializeStableEntry(key, obj[key])).join(",") + "}";
}

export function parseInclusivePeriod(from: string, toInclusive: string): {
  from: Date;
  toInclusive: Date;
  toExclusive: Date;
  fromIso: string;
  toInclusiveIso: string;
  toExclusiveIso: string;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(toInclusive)) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_INVALID_PERIOD,
      "التواريخ يجب أن تكون بصيغة YYYY-MM-DD"
    );
  }
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toInclusiveDate = new Date(`${toInclusive}T00:00:00.000Z`);
  if (
    fromDate.toISOString().slice(0, 10) !== from ||
    toInclusiveDate.toISOString().slice(0, 10) !== toInclusive
  ) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_INVALID_PERIOD,
      "قيمة تاريخ غير صالحة"
    );
  }
  if (toInclusiveDate < fromDate) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_INVALID_PERIOD,
      "تاريخ النهاية يجب أن يكون بعد أو يساوي تاريخ البداية"
    );
  }
  const toExclusive = new Date(toInclusiveDate.getTime() + DAY_MS);
  return {
    from: fromDate,
    toInclusive: toInclusiveDate,
    toExclusive,
    fromIso: from,
    toInclusiveIso: toInclusive,
    toExclusiveIso: toExclusive.toISOString().slice(0, 10),
  };
}

export function validateBatchSize(batchSize: number): number {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_INVALID_BATCH_SIZE,
      `حجم الدفعة يجب أن يكون بين 1 و ${MAX_BATCH_SIZE}`
    );
  }
  return batchSize;
}

export function buildConfirmationToken(input: {
  manifestHash: string;
  taxonomyFingerprint: string;
  eligibleCount: number;
  periodFrom: string;
  periodTo: string;
}): string {
  const material = [
    input.manifestHash,
    input.taxonomyFingerprint,
    String(input.eligibleCount),
    input.periodFrom,
    input.periodTo,
  ].join("|");
  const hash = createHash("sha256").update(material, "utf8").digest("hex").toUpperCase();
  return `APPLY-${input.eligibleCount}-${hash.slice(0, 10)}`;
}

export function buildRollbackToken(input: {
  runId: string;
  manifestHash: string;
  appliedCount: number;
}): string {
  const material = [input.runId, input.manifestHash, String(input.appliedCount)].join("|");
  const hash = createHash("sha256").update(material, "utf8").digest("hex").toUpperCase();
  return `ROLLBACK-${input.appliedCount}-${hash.slice(0, 10)}`;
}

export function computeManifestHash(manifestWithoutHashAndToken: Omit<
  BackfillManifest,
  "manifestHash" | "confirmationToken"
>): string {
  const rows = [...manifestWithoutHashAndToken.rows].sort((a, b) =>
    compareCodeUnits(a.complaintId, b.complaintId)
  );
  const payload = {
    ...manifestWithoutHashAndToken,
    rows,
    classificationDistribution: [...manifestWithoutHashAndToken.classificationDistribution].sort(
      (a, b) => compareCodeUnits(a.classificationId, b.classificationId)
    ),
  };
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}

function assertNoPiiInManifest(manifest: BackfillManifest): void {
  const forbidden = [
    "sourceDetail",
    "description",
    "subject",
    "complainantName",
    "complainantIdentifier",
    "complainantPhone",
  ];
  const serialized = JSON.stringify(manifest);
  for (const key of forbidden) {
    if (serialized.includes(`"${key}"`)) {
      throw new HistoricalBackfillError(
        BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_INVALID,
        `manifest يحتوي حقلًا محظورًا: ${key}`
      );
    }
  }
}

export async function writeManifestAtomically(
  path: string,
  manifest: BackfillManifest,
  options: { overwrite?: boolean } = {}
): Promise<void> {
  const absolute = resolve(path);
  if (existsSync(absolute) && !options.overwrite) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_EXISTS,
      "ملف manifest موجود مسبقًا؛ استخدم --overwrite=true"
    );
  }
  mkdirSync(dirname(absolute), { recursive: true });
  const tempPath = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  const stream = createWriteStream(tempPath, { encoding: "utf8", mode: 0o600 });
  stream.write(`${JSON.stringify(manifest, null, 2)}\n`);
  stream.end();
  await finished(stream);
  try {
    const fd = await import("node:fs/promises").then((fs) => fs.open(tempPath, "r+"));
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  } catch {
    // fsync best-effort
  }
  renameSync(tempPath, absolute);
  try {
    chmodSync(absolute, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
}

function effectiveDateWhere(from: Date, toExclusive: Date): Prisma.ComplaintWhereInput {
  return {
    isDeleted: false,
    OR: [
      { complaintDate: { gte: from, lt: toExclusive } },
      {
        complaintDate: null,
        receivedAt: { gte: from, lt: toExclusive },
      },
    ],
  };
}

function inPeriod(complaint: { complaintDate: Date | null; receivedAt: Date }, from: Date, toExclusive: Date): boolean {
  const effective = complaint.complaintDate ?? complaint.receivedAt;
  return effective >= from && effective < toExclusive;
}

export async function loadActiveTaxonomy(
  db: BackfillDb
): Promise<TaxonomyFingerprintClassification[]> {
  return db.classification.findMany({
    where: {
      isDeleted: false,
      isActive: true,
      category: { isDeleted: false, isActive: true },
    },
    select: {
      id: true,
      nameAr: true,
      keywords: true,
      isActive: true,
      isDeleted: true,
      category: {
        select: { id: true, nameAr: true, isActive: true, isDeleted: true },
      },
    },
    orderBy: { id: "asc" },
  });
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}

type PreviewCounters = BackfillManifest["totals"];

function emptyCounters(): PreviewCounters {
  return {
    eligibleCount: 0,
    alreadyClassifiedCount: 0,
    manuallyProtectedCount: 0,
    ambiguousCount: 0,
    unmatchedCount: 0,
    missingSourceDetailCount: 0,
    inactiveTargetCount: 0,
    outsidePeriodCount: 0,
  };
}


type PreviewComplaintInput = {
  id: string;
  version: number;
  classificationId: string | null;
  categoryId: string | null;
  classificationAssignmentSource: string | null;
  sourceDetail: string | null;
  complaintDate: Date | null;
  receivedAt: Date;
};

type PreviewEvaluation =
  | { kind: "OUTSIDE_PERIOD" }
  | { kind: "ALREADY_CLASSIFIED" }
  | { kind: "MANUALLY_PROTECTED" }
  | { kind: "MISSING_SOURCE_DETAIL" }
  | { kind: "AMBIGUOUS" }
  | { kind: "UNMATCHED" }
  | { kind: "INACTIVE_CLASSIFICATION" }
  | {
      kind: "ELIGIBLE";
      sourceDetail: string;
      match: {
        classificationId: string;
        classificationName: string;
        categoryId: string;
        categoryName: string;
      };
    };

function evaluatePreviewComplaint(
  complaint: PreviewComplaintInput,
  period: { from: Date; toExclusive: Date },
  candidates: SourceDetailClassificationCandidate[],
  activeIds: Set<string>
): PreviewEvaluation {
  if (!inPeriod(complaint, period.from, period.toExclusive)) {
    return { kind: "OUTSIDE_PERIOD" };
  }
  if (complaint.classificationId) {
    return { kind: "ALREADY_CLASSIFIED" };
  }
  if (
    isManuallyProtectedUnclassified({
      classificationId: complaint.classificationId,
      classificationAssignmentSource: complaint.classificationAssignmentSource,
    }) ||
    complaint.classificationAssignmentSource != null
  ) {
    return { kind: "MANUALLY_PROTECTED" };
  }

  const sourceDetail = complaint.sourceDetail?.trim();
  if (!sourceDetail) {
    return { kind: "MISSING_SOURCE_DETAIL" };
  }

  const resolution = resolveSourceDetailClassification({
    sourceDetail,
    classifications: candidates,
  });

  if (resolution.status === "AMBIGUOUS") {
    return { kind: "AMBIGUOUS" };
  }
  if (resolution.status === "UNMATCHED" || resolution.status === "NO_SOURCE_DETAIL") {
    return resolution.status === "NO_SOURCE_DETAIL"
      ? { kind: "MISSING_SOURCE_DETAIL" }
      : { kind: "UNMATCHED" };
  }
  if (resolution.status !== "MATCHED") {
    return { kind: "UNMATCHED" };
  }
  if (!activeIds.has(resolution.match.classificationId)) {
    return { kind: "INACTIVE_CLASSIFICATION" };
  }
  return { kind: "ELIGIBLE", sourceDetail, match: resolution.match };
}

function bumpPreviewCounter(totals: PreviewCounters, kind: PreviewEvaluation["kind"]): void {
  switch (kind) {
    case "OUTSIDE_PERIOD":
      totals.outsidePeriodCount += 1;
      break;
    case "ALREADY_CLASSIFIED":
      totals.alreadyClassifiedCount += 1;
      break;
    case "MANUALLY_PROTECTED":
      totals.manuallyProtectedCount += 1;
      break;
    case "MISSING_SOURCE_DETAIL":
      totals.missingSourceDetailCount += 1;
      break;
    case "AMBIGUOUS":
      totals.ambiguousCount += 1;
      break;
    case "UNMATCHED":
      totals.unmatchedCount += 1;
      break;
    case "INACTIVE_CLASSIFICATION":
      totals.inactiveTargetCount += 1;
      break;
    case "ELIGIBLE":
      totals.eligibleCount += 1;
      break;
  }
}

function updatePreviewDistribution(
  distribution: Map<string, ClassificationDistributionEntry>,
  match: {
    classificationId: string;
    classificationName: string;
    categoryId: string;
    categoryName: string;
  }
): void {
  const existing = distribution.get(match.classificationId);
  if (existing) {
    existing.eligibleCount += 1;
    return;
  }
  distribution.set(match.classificationId, {
    classificationId: match.classificationId,
    classificationName: match.classificationName,
    categoryId: match.categoryId,
    categoryName: match.categoryName,
    eligibleCount: 1,
  });
}

export async function previewHistoricalClassificationBackfill(
  db: BackfillDb,
  input: {
    from: string;
    toInclusive: string;
    manifestPath: string;
    overwrite?: boolean;
    actor?: string;
  }
): Promise<DryRunResult> {
  const period = parseInclusivePeriod(input.from, input.toInclusive);
  const taxonomy = await loadActiveTaxonomy(db);
  const taxonomyFingerprint = computeTaxonomyFingerprint(taxonomy);
  const candidates = taxonomy as SourceDetailClassificationCandidate[];
  const activeIds = new Set(taxonomy.map((c) => c.id));

  const complaints = await db.complaint.findMany({
    where: effectiveDateWhere(period.from, period.toExclusive),
    select: {
      id: true,
      version: true,
      classificationId: true,
      categoryId: true,
      classificationAssignmentSource: true,
      sourceDetail: true,
      complaintDate: true,
      receivedAt: true,
      isDeleted: true,
    },
    orderBy: { id: "asc" },
  });

  const totals = emptyCounters();
  const distribution = new Map<string, ClassificationDistributionEntry>();
  const rows: ManifestRow[] = [];

  for (const complaint of complaints) {
    const evaluation = evaluatePreviewComplaint(
      complaint,
      { from: period.from, toExclusive: period.toExclusive },
      candidates,
      activeIds
    );
    bumpPreviewCounter(totals, evaluation.kind);
    if (evaluation.kind !== "ELIGIBLE") {
      continue;
    }
    updatePreviewDistribution(distribution, evaluation.match);
    rows.push({
      complaintId: complaint.id,
      expectedVersion: complaint.version,
      previousClassificationId: null,
      previousCategoryId: complaint.categoryId,
      previousAssignmentSource: null,
      targetClassificationId: evaluation.match.classificationId,
      targetCategoryId: evaluation.match.categoryId,
      targetClassificationName: evaluation.match.classificationName,
      sourceDetailHash: hashSourceDetailValue(evaluation.sourceDetail),
      matchCode: "MATCHED",
    });
  }

  rows.sort((a, b) => compareCodeUnits(a.complaintId, b.complaintId));
  const classificationDistribution = [...distribution.values()].sort((a, b) =>
    compareCodeUnits(a.classificationId, b.classificationId)
  );

  const withoutHash: Omit<BackfillManifest, "manifestHash" | "confirmationToken"> = {
    schemaVersion: BACKFILL_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    period: {
      from: period.fromIso,
      toInclusive: period.toInclusiveIso,
      toExclusive: period.toExclusiveIso,
    },
    taxonomyFingerprint,
    totals,
    classificationDistribution,
    rows,
  };

  const manifestHash = computeManifestHash(withoutHash);
  const confirmationToken = buildConfirmationToken({
    manifestHash,
    taxonomyFingerprint,
    eligibleCount: totals.eligibleCount,
    periodFrom: period.fromIso,
    periodTo: period.toInclusiveIso,
  });

  const manifest: BackfillManifest = {
    ...withoutHash,
    manifestHash,
    confirmationToken,
  };
  assertNoPiiInManifest(manifest);
  await writeManifestAtomically(input.manifestPath, manifest, {
    overwrite: input.overwrite === true,
  });

  return {
    mode: "dry-run",
    manifestPath: resolve(input.manifestPath),
    manifestHash,
    taxonomyFingerprint,
    eligibleCount: totals.eligibleCount,
    ambiguousCount: totals.ambiguousCount,
    unmatchedCount: totals.unmatchedCount,
    manuallyProtectedCount: totals.manuallyProtectedCount,
    alreadyClassifiedCount: totals.alreadyClassifiedCount,
    missingSourceDetailCount: totals.missingSourceDetailCount,
    inactiveTargetCount: totals.inactiveTargetCount,
    classificationDistribution,
    confirmationToken,
  };
}

export function readAndValidateManifest(path: string): BackfillManifest {
  if (!path) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_REQUIRED,
      "مسار manifest مطلوب"
    );
  }
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_NOT_FOUND,
      "ملف manifest غير موجود"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_INVALID,
      "تعذر قراءة manifest"
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_INVALID,
      "صيغة manifest غير صالحة"
    );
  }

  const manifest = parsed as BackfillManifest;
  if (manifest.schemaVersion !== BACKFILL_SCHEMA_VERSION) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_SCHEMA_VERSION_UNSUPPORTED,
      `إصدار schema غير مدعوم: ${String(manifest.schemaVersion)}`
    );
  }

  if (!Array.isArray(manifest.rows) || !manifest.manifestHash || !manifest.confirmationToken) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_INVALID,
      "حقول manifest الأساسية ناقصة"
    );
  }

  const ids = new Set<string>();
  for (const row of manifest.rows) {
    if (!row?.complaintId || ids.has(row.complaintId)) {
      throw new HistoricalBackfillError(
        BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_INVALID,
        "complaintId مكرر أو مفقود في manifest"
      );
    }
    ids.add(row.complaintId);
  }

  const { manifestHash: storedHash, confirmationToken: storedToken, ...rest } = manifest;
  const recomputed = computeManifestHash(rest);
  if (recomputed !== storedHash) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_HASH_MISMATCH,
      "بصمة manifest لا تطابق المحتوى"
    );
  }

  const expectedToken = buildConfirmationToken({
    manifestHash: storedHash,
    taxonomyFingerprint: manifest.taxonomyFingerprint,
    eligibleCount: manifest.totals.eligibleCount,
    periodFrom: manifest.period.from,
    periodTo: manifest.period.toInclusive,
  });
  if (storedToken !== expectedToken) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_MANIFEST_INVALID,
      "رمز تأكيد manifest غير متسق مع المحتوى"
    );
  }

  assertNoPiiInManifest(manifest);
  return manifest;
}

async function assertTaxonomyMatchesManifest(
  db: BackfillDb,
  manifest: BackfillManifest
): Promise<TaxonomyFingerprintClassification[]> {
  const taxonomy = await loadActiveTaxonomy(db);
  const fingerprint = computeTaxonomyFingerprint(taxonomy);
  if (fingerprint !== manifest.taxonomyFingerprint) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.CLASSIFICATION_TAXONOMY_CHANGED,
      "تغير قاموس التصنيفات منذ المعاينة"
    );
  }

  const activeIds = new Set(taxonomy.map((c) => c.id));
  for (const row of manifest.rows) {
    const target = taxonomy.find((c) => c.id === row.targetClassificationId);
    if (!target || !activeIds.has(row.targetClassificationId)) {
      throw new HistoricalBackfillError(
        BACKFILL_ERROR_CODES.CLASSIFICATION_TAXONOMY_CHANGED,
        "تصنيف مستهدف لم يعد ضمن القاموس النشط"
      );
    }
    if (target.category.id !== row.targetCategoryId) {
      throw new HistoricalBackfillError(
        BACKFILL_ERROR_CODES.CLASSIFICATION_TAXONOMY_CHANGED,
        "تصنيف مستهدف لم يعد يتبع الفئة المعاينة"
      );
    }
  }
  return taxonomy;
}

function sanitizeFailureMessage(error: unknown): string {
  if (error instanceof HistoricalBackfillError) return error.message;
  if (error instanceof Error) {
    return error.message.slice(0, 200).replace(/\s+/g, " ");
  }
  return "UNEXPECTED_ERROR";
}


type ApplyItemDecision =
  | { action: "SKIP"; reason: string }
  | { action: "APPLY"; targetCategoryId: string };

async function markBackfillItemSkipped(
  tx: Prisma.TransactionClient,
  itemId: string,
  reason: string
): Promise<void> {
  await tx.classificationBackfillItem.update({
    where: { id: itemId },
    data: {
      result: BACKFILL_ITEM_RESULTS.SKIPPED,
      skipReason: reason,
    },
  });
}

function resolveResolutionSkipReason(status: string): string {
  if (status === "AMBIGUOUS") return BACKFILL_SKIP_REASONS.AMBIGUOUS;
  if (status === "UNMATCHED") return BACKFILL_SKIP_REASONS.UNMATCHED;
  return BACKFILL_SKIP_REASONS.TARGET_CHANGED;
}

function evaluateApplyItem(input: {
  complaint:
    | {
        id: string;
        version: number;
        isDeleted: boolean;
        classificationId: string | null;
        classificationAssignmentSource: string | null;
        sourceDetail: string | null;
      }
    | null;
  item: {
    expectedVersion: number;
    sourceDetailHash: string;
    targetClassificationId: string;
    targetCategoryId: string | null;
  };
  activeIds: Set<string>;
  candidates: SourceDetailClassificationCandidate[];
}): ApplyItemDecision {
  const { complaint, item, activeIds, candidates } = input;
  if (!complaint || complaint.isDeleted) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.DELETED_AFTER_PREVIEW };
  }
  if (complaint.classificationId != null) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.ALREADY_CLASSIFIED };
  }
  if (
    isManuallyProtectedUnclassified({
      classificationId: complaint.classificationId,
      classificationAssignmentSource: complaint.classificationAssignmentSource,
    }) ||
    complaint.classificationAssignmentSource != null
  ) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.MANUALLY_PROTECTED };
  }
  if (complaint.version !== item.expectedVersion) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.VERSION_CHANGED };
  }
  const sourceDetail = complaint.sourceDetail?.trim();
  if (!sourceDetail) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.MISSING_SOURCE_DETAIL };
  }
  if (hashSourceDetailValue(sourceDetail) !== item.sourceDetailHash) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.SOURCE_DETAIL_CHANGED };
  }
  if (!activeIds.has(item.targetClassificationId)) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.INACTIVE_CLASSIFICATION };
  }
  const resolution = resolveSourceDetailClassification({
    sourceDetail,
    classifications: candidates,
  });
  if (
    resolution.status !== "MATCHED" ||
    resolution.match.classificationId !== item.targetClassificationId
  ) {
    return {
      action: "SKIP",
      reason: resolveResolutionSkipReason(resolution.status),
    };
  }
  const targetCategoryId = item.targetCategoryId ?? resolution.match.categoryId;
  if (
    !targetCategoryId ||
    resolution.match.categoryId !== targetCategoryId ||
    (item.targetCategoryId != null && item.targetCategoryId !== resolution.match.categoryId)
  ) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.CATEGORY_CLASSIFICATION_MISMATCH };
  }
  return { action: "APPLY", targetCategoryId };
}

function resolveApplyRunStatus(input: {
  halted: boolean;
  failedDb: number;
  plannedDb: number;
  appliedDb: number;
}): BackfillRunStatus {
  if (input.halted || input.failedDb > 0 || input.plannedDb > 0) {
    if (input.appliedDb > 0) return BACKFILL_RUN_STATUSES.PARTIALLY_APPLIED;
    return BACKFILL_RUN_STATUSES.FAILED;
  }
  return BACKFILL_RUN_STATUSES.APPLIED;
}

function resolveApplyAuditAction(status: BackfillRunStatus): string {
  if (status === BACKFILL_RUN_STATUSES.APPLIED) {
    return "CLASSIFICATION_HISTORICAL_BACKFILL_APPLIED";
  }
  if (status === BACKFILL_RUN_STATUSES.PARTIALLY_APPLIED) {
    return "CLASSIFICATION_HISTORICAL_BACKFILL_PARTIALLY_APPLIED";
  }
  return "CLASSIFICATION_HISTORICAL_BACKFILL_FAILED";
}


type ApplyInput = {
  manifestPath: string;
  confirm?: string;
  batchSize?: number;
  actor?: string;
  resumeRunId?: string;
};

type ApplyBatchContext = {
  db: BackfillDb;
  runId: string;
  actor: string;
  manifest: BackfillManifest;
  batchSize: number;
  candidates: SourceDetailClassificationCandidate[];
  activeIds: Set<string>;
};

type ApplyBatchOutcome = {
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  halted: boolean;
  failureCode: string | null;
  failureMessage: string | null;
};

type ApplyRecount = {
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  plannedCount: number;
};

function validateApplyInput(input: ApplyInput): { batchSize: number; actor: string; confirm: string } {
  if (!input.confirm) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_CONFIRMATION_REQUIRED,
      "رمز التأكيد مطلوب لتطبيق الـBackfill"
    );
  }
  return {
    batchSize: validateBatchSize(input.batchSize ?? DEFAULT_BATCH_SIZE),
    actor: input.actor ?? AUDIT_ACTOR_SYSTEM,
    confirm: input.confirm,
  };
}

function loadAndValidateApplyManifest(manifestPath: string, confirm: string): BackfillManifest {
  const manifest = readAndValidateManifest(manifestPath);
  if (confirm !== manifest.confirmationToken) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_CONFIRMATION_INVALID,
      "رمز التأكيد غير صحيح"
    );
  }
  return manifest;
}

async function assertApplyCanStart(
  db: BackfillDb,
  manifest: BackfillManifest,
  resumeRunId?: string
): Promise<void> {
  await assertTaxonomyMatchesManifest(db, manifest);

  const existingApplied = await db.classificationBackfillRun.findFirst({
    where: {
      manifestHash: manifest.manifestHash,
      status: BACKFILL_RUN_STATUSES.APPLIED,
      operation: BACKFILL_OPERATIONS.APPLY,
    },
    orderBy: { startedAt: "desc" },
  });
  if (existingApplied && !resumeRunId) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_ALREADY_APPLIED,
      "تم تطبيق هذا الـmanifest مسبقًا",
      { runId: existingApplied.id }
    );
  }

  const existingPartial = await db.classificationBackfillRun.findFirst({
    where: {
      manifestHash: manifest.manifestHash,
      status: BACKFILL_RUN_STATUSES.PARTIALLY_APPLIED,
      operation: BACKFILL_OPERATIONS.APPLY,
    },
    orderBy: { startedAt: "desc" },
  });
  if (existingPartial && !resumeRunId) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_PARTIAL_NEEDS_EXPLICIT_RESUME,
      "يوجد تشغيل جزئي؛ استكمل بـ --run-id أو نفّذ rollback",
      { runId: existingPartial.id }
    );
  }
}

async function createPlannedBackfillItems(
  db: BackfillDb,
  runId: string,
  manifest: BackfillManifest,
  batchSize: number
): Promise<void> {
  for (const batch of chunks(manifest.rows, batchSize)) {
    if (batch.length === 0) continue;
    await db.classificationBackfillItem.createMany({
      data: batch.map((row) => ({
        runId,
        complaintId: row.complaintId,
        expectedVersion: row.expectedVersion,
        previousClassificationId: row.previousClassificationId,
        previousCategoryId: row.previousCategoryId ?? null,
        targetClassificationId: row.targetClassificationId,
        targetCategoryId: row.targetCategoryId,
        targetClassificationNameSnapshot: row.targetClassificationName,
        previousAssignmentSource: row.previousAssignmentSource,
        targetAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL,
        sourceDetailHash: row.sourceDetailHash,
        result: BACKFILL_ITEM_RESULTS.PLANNED,
      })),
    });
  }
}

async function prepareOrResumeApplyRun(
  db: BackfillDb,
  manifest: BackfillManifest,
  batchSize: number,
  actor: string,
  resumeRunId?: string
): Promise<string> {
  if (resumeRunId) {
    const run = await db.classificationBackfillRun.findUnique({ where: { id: resumeRunId } });
    if (run?.manifestHash !== manifest.manifestHash) {
      throw new HistoricalBackfillError(
        BACKFILL_ERROR_CODES.BACKFILL_RUN_NOT_FOUND,
        "تشغيل الاستكمال غير موجود أو لا يطابق الـmanifest"
      );
    }
    await db.classificationBackfillRun.update({
      where: { id: resumeRunId },
      data: { status: BACKFILL_RUN_STATUSES.APPLYING, failureCode: null, failureMessage: null },
    });
    return resumeRunId;
  }

  const run = await db.classificationBackfillRun.create({
    data: {
      operation: BACKFILL_OPERATIONS.APPLY,
      status: BACKFILL_RUN_STATUSES.APPLYING,
      periodFrom: new Date(`${manifest.period.from}T00:00:00.000Z`),
      periodToExclusive: new Date(`${manifest.period.toExclusive}T00:00:00.000Z`),
      taxonomyFingerprint: manifest.taxonomyFingerprint,
      manifestHash: manifest.manifestHash,
      eligibleCount: manifest.totals.eligibleCount,
      plannedCount: manifest.rows.length,
      batchSize,
      actor,
    },
  });

  await createPlannedBackfillItems(db, run.id, manifest, batchSize);

  await writeAuditLog(db, {
    action: "CLASSIFICATION_HISTORICAL_BACKFILL_STARTED",
    entityType: "ClassificationBackfillRun",
    entityId: run.id,
    actor,
    metadata: {
      runId: run.id,
      manifestHash: manifest.manifestHash,
      taxonomyFingerprint: manifest.taxonomyFingerprint,
      periodFrom: manifest.period.from,
      periodTo: manifest.period.toInclusive,
      eligibleCount: manifest.totals.eligibleCount,
      plannedCount: manifest.rows.length,
      batchSize,
      classificationDistribution: manifest.classificationDistribution,
      startedAt: new Date().toISOString(),
    },
  });

  return run.id;
}

async function loadPendingBackfillItems(db: BackfillDb, runId: string) {
  return db.classificationBackfillItem.findMany({
    where: {
      runId,
      result: { in: [BACKFILL_ITEM_RESULTS.PLANNED, BACKFILL_ITEM_RESULTS.FAILED] },
    },
    orderBy: { complaintId: "asc" },
  });
}

async function processApplyBatch(
  ctx: ApplyBatchContext,
  batch: Awaited<ReturnType<typeof loadPendingBackfillItems>>
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  await ctx.db.$transaction(async (tx) => {
    for (const item of batch) {
      const complaint = await tx.complaint.findUnique({
        where: { id: item.complaintId },
        select: {
          id: true,
          version: true,
          isDeleted: true,
          classificationId: true,
          classificationAssignmentSource: true,
          sourceDetail: true,
        },
      });

      const decision = evaluateApplyItem({
        complaint,
        item,
        activeIds: ctx.activeIds,
        candidates: ctx.candidates,
      });
      if (decision.action === "SKIP") {
        await markBackfillItemSkipped(tx, item.id, decision.reason);
        skipped += 1;
        continue;
      }

      const assignment = buildClassificationAssignmentMetadata({
        source: CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL,
        assignedBy: ctx.actor,
        taxonomyFingerprint: ctx.manifest.taxonomyFingerprint,
        assignmentRunId: ctx.runId,
      });

      const updateResult = await tx.complaint.updateMany({
        where: {
          id: complaint!.id,
          version: item.expectedVersion,
          isDeleted: false,
          classificationId: null,
          classificationAssignmentSource: null,
        },
        data: {
          classificationId: item.targetClassificationId,
          categoryId: decision.targetCategoryId,
          ...assignment,
          version: { increment: 1 },
        },
      });

      if (updateResult.count !== 1) {
        await markBackfillItemSkipped(tx, item.id, BACKFILL_SKIP_REASONS.VERSION_CHANGED);
        skipped += 1;
        continue;
      }

      await tx.classificationBackfillItem.update({
        where: { id: item.id },
        data: {
          result: BACKFILL_ITEM_RESULTS.APPLIED,
          appliedVersion: item.expectedVersion + 1,
          appliedAt: new Date(),
          skipReason: null,
        },
      });
      applied += 1;
    }
  });
  return { applied, skipped };
}

async function processApplyBatches(
  ctx: ApplyBatchContext,
  pendingItems: Awaited<ReturnType<typeof loadPendingBackfillItems>>
): Promise<ApplyBatchOutcome> {
  let appliedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let halted = false;
  let failureCode: string | null = null;
  let failureMessage: string | null = null;

  for (const batch of chunks(pendingItems, ctx.batchSize)) {
    if (halted) break;
    try {
      const result = await processApplyBatch(ctx, batch);
      appliedCount += result.applied;
      skippedCount += result.skipped;
    } catch (error) {
      halted = true;
      failureCode = "BATCH_TRANSACTION_FAILED";
      failureMessage = sanitizeFailureMessage(error);
      failedCount += batch.length;
      await ctx.db.classificationBackfillItem.updateMany({
        where: {
          runId: ctx.runId,
          id: { in: batch.map((b) => b.id) },
          result: BACKFILL_ITEM_RESULTS.PLANNED,
        },
        data: {
          result: BACKFILL_ITEM_RESULTS.FAILED,
          skipReason: failureCode,
        },
      });
    }
  }

  return { appliedCount, skippedCount, failedCount, halted, failureCode, failureMessage };
}

async function recountApplyResults(db: BackfillDb, runId: string): Promise<ApplyRecount> {
  const [appliedCount, skippedCount, failedCount, plannedCount] = await Promise.all([
    db.classificationBackfillItem.count({
      where: { runId, result: BACKFILL_ITEM_RESULTS.APPLIED },
    }),
    db.classificationBackfillItem.count({
      where: { runId, result: BACKFILL_ITEM_RESULTS.SKIPPED },
    }),
    db.classificationBackfillItem.count({
      where: { runId, result: BACKFILL_ITEM_RESULTS.FAILED },
    }),
    db.classificationBackfillItem.count({
      where: { runId, result: BACKFILL_ITEM_RESULTS.PLANNED },
    }),
  ]);
  return { appliedCount, skippedCount, failedCount, plannedCount };
}

async function finalizeApplyRun(input: {
  db: BackfillDb;
  runId: string;
  actor: string;
  manifest: BackfillManifest;
  batchSize: number;
  recount: ApplyRecount;
  halted: boolean;
  failureCode: string | null;
  failureMessage: string | null;
}): Promise<{ status: BackfillRunStatus; completedAt: Date }> {
  const status = resolveApplyRunStatus({
    halted: input.halted,
    failedDb: input.recount.failedCount,
    plannedDb: input.recount.plannedCount,
    appliedDb: input.recount.appliedCount,
  });
  const completedAt = new Date();
  await input.db.classificationBackfillRun.update({
    where: { id: input.runId },
    data: {
      status,
      appliedCount: input.recount.appliedCount,
      skippedCount: input.recount.skippedCount,
      failedCount: input.recount.failedCount,
      completedAt,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
    },
  });

  await writeAuditLog(input.db, {
    action: resolveApplyAuditAction(status),
    entityType: "ClassificationBackfillRun",
    entityId: input.runId,
    actor: input.actor,
    metadata: {
      runId: input.runId,
      manifestHash: input.manifest.manifestHash,
      taxonomyFingerprint: input.manifest.taxonomyFingerprint,
      periodFrom: input.manifest.period.from,
      periodTo: input.manifest.period.toInclusive,
      eligibleCount: input.manifest.totals.eligibleCount,
      plannedCount: input.manifest.rows.length,
      appliedCount: input.recount.appliedCount,
      skippedCount: input.recount.skippedCount,
      failedCount: input.recount.failedCount,
      batchSize: input.batchSize,
      classificationDistribution: input.manifest.classificationDistribution,
      completedAt: completedAt.toISOString(),
    },
  });

  return { status, completedAt };
}

function buildApplyResult(input: {
  runId: string;
  status: BackfillRunStatus;
  manifest: BackfillManifest;
  recount: ApplyRecount;
}): ApplyResult {
  return {
    mode: "apply",
    runId: input.runId,
    status: input.status,
    manifestHash: input.manifest.manifestHash,
    taxonomyFingerprint: input.manifest.taxonomyFingerprint,
    plannedCount: input.manifest.rows.length,
    appliedCount: input.recount.appliedCount,
    skippedCount: input.recount.skippedCount,
    failedCount: input.recount.failedCount,
    confirmationToken: input.manifest.confirmationToken,
    rollbackToken: buildRollbackToken({
      runId: input.runId,
      manifestHash: input.manifest.manifestHash,
      appliedCount: input.recount.appliedCount,
    }),
  };
}

export async function applyHistoricalClassificationBackfill(
  db: BackfillDb,
  input: ApplyInput
): Promise<ApplyResult> {
  const { batchSize, actor, confirm } = validateApplyInput(input);
  const manifest = loadAndValidateApplyManifest(input.manifestPath, confirm);
  await assertApplyCanStart(db, manifest, input.resumeRunId);
  const runId = await prepareOrResumeApplyRun(db, manifest, batchSize, actor, input.resumeRunId);

  const taxonomy = await loadActiveTaxonomy(db);
  const batchOutcome = await processApplyBatches(
    {
      db,
      runId,
      actor,
      manifest,
      batchSize,
      candidates: taxonomy as SourceDetailClassificationCandidate[],
      activeIds: new Set(taxonomy.map((c) => c.id)),
    },
    await loadPendingBackfillItems(db, runId)
  );

  const recount = await recountApplyResults(db, runId);
  const { status } = await finalizeApplyRun({
    db,
    runId,
    actor,
    manifest,
    batchSize,
    recount,
    halted: batchOutcome.halted,
    failureCode: batchOutcome.failureCode,
    failureMessage: batchOutcome.failureMessage,
  });

  return buildApplyResult({ runId, status, manifest, recount });
}

type VerificationRun = NonNullable<
  Awaited<ReturnType<BackfillDb["classificationBackfillRun"]["findUnique"]>>
>;
type VerificationItem = Awaited<
  ReturnType<BackfillDb["classificationBackfillItem"]["findMany"]>
>[number];

type PartitionedVerificationItems = {
  appliedItems: VerificationItem[];
  skippedItems: VerificationItem[];
  failedItems: VerificationItem[];
  rolledBackItems: VerificationItem[];
  rollbackSkippedItems: VerificationItem[];
};

function isRollbackTerminalOrActive(run: VerificationRun): boolean {
  if (run.operation === BACKFILL_OPERATIONS.ROLLBACK) return true;
  return (
    run.status === BACKFILL_RUN_STATUSES.ROLLED_BACK ||
    run.status === BACKFILL_RUN_STATUSES.PARTIALLY_ROLLED_BACK ||
    run.status === BACKFILL_RUN_STATUSES.ROLLING_BACK
  );
}

function isApplyVerifiableState(run: VerificationRun): boolean {
  if (run.operation !== BACKFILL_OPERATIONS.APPLY) return false;
  return (
    run.status === BACKFILL_RUN_STATUSES.APPLYING ||
    run.status === BACKFILL_RUN_STATUSES.APPLIED ||
    run.status === BACKFILL_RUN_STATUSES.PARTIALLY_APPLIED ||
    run.status === BACKFILL_RUN_STATUSES.FAILED ||
    run.status === BACKFILL_RUN_STATUSES.VERIFY_FAILED
  );
}

async function loadVerificationRun(db: BackfillDb, runId: string): Promise<VerificationRun> {
  const run = await db.classificationBackfillRun.findUnique({ where: { id: runId } });
  if (!run) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_RUN_NOT_FOUND,
      "تشغيل الـBackfill غير موجود"
    );
  }
  return run;
}

async function loadVerificationItems(db: BackfillDb, runId: string): Promise<VerificationItem[]> {
  return db.classificationBackfillItem.findMany({ where: { runId } });
}

function partitionVerificationItems(items: VerificationItem[]): PartitionedVerificationItems {
  return {
    appliedItems: items.filter((i) => i.result === BACKFILL_ITEM_RESULTS.APPLIED),
    skippedItems: items.filter((i) => i.result === BACKFILL_ITEM_RESULTS.SKIPPED),
    failedItems: items.filter((i) => i.result === BACKFILL_ITEM_RESULTS.FAILED),
    rolledBackItems: items.filter((i) => i.result === BACKFILL_ITEM_RESULTS.ROLLED_BACK),
    rollbackSkippedItems: items.filter((i) => i.result === BACKFILL_ITEM_RESULTS.ROLLBACK_SKIPPED),
  };
}

function buildApplyCountInvariants(
  run: VerificationRun,
  items: VerificationItem[],
  partitioned: PartitionedVerificationItems
): VerifyResult["invariants"] {
  return [
    {
      code: "PLANNED_COUNT",
      ok: items.length === run.plannedCount,
      detail: `${items.length}/${run.plannedCount}`,
    },
    {
      code: "APPLIED_COUNT",
      ok: partitioned.appliedItems.length === run.appliedCount,
      detail: `${partitioned.appliedItems.length}/${run.appliedCount}`,
    },
    {
      code: "SKIPPED_COUNT",
      ok: partitioned.skippedItems.length === run.skippedCount,
      detail: `${partitioned.skippedItems.length}/${run.skippedCount}`,
    },
    {
      code: "FAILED_COUNT",
      ok: partitioned.failedItems.length === run.failedCount,
      detail: `${partitioned.failedItems.length}/${run.failedCount}`,
    },
  ];
}

async function verifyAppliedBatch(
  db: BackfillDb,
  run: VerificationRun,
  batch: VerificationItem[],
  invariants: VerifyResult["invariants"]
): Promise<boolean> {
  const complaints = await db.complaint.findMany({
    where: { id: { in: batch.map((i) => i.complaintId) } },
    select: {
      id: true,
      classificationId: true,
      categoryId: true,
      classificationAssignmentSource: true,
      classificationAssignmentRunId: true,
      classificationTaxonomyFingerprint: true,
      isDeleted: true,
      classification: { select: { categoryId: true } },
    },
  });
  const byId = new Map(complaints.map((c) => [c.id, c]));
  for (const item of batch) {
    const c = byId.get(item.complaintId);
    if (
      !c ||
      c.isDeleted ||
      c.classificationId !== item.targetClassificationId ||
      c.classificationAssignmentSource !== CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL ||
      c.classificationAssignmentRunId !== run.id ||
      c.classificationTaxonomyFingerprint !== run.taxonomyFingerprint
    ) {
      return false;
    }
    if (
      !c.categoryId ||
      !c.classification ||
      c.categoryId !== c.classification.categoryId ||
      (item.targetCategoryId != null && c.categoryId !== item.targetCategoryId)
    ) {
      invariants.push({
        code: BACKFILL_SKIP_REASONS.CATEGORY_CLASSIFICATION_MISMATCH,
        ok: false,
        detail: c.id,
      });
      return false;
    }
  }
  return true;
}

async function verifyAppliedItems(
  db: BackfillDb,
  run: VerificationRun,
  appliedItems: VerificationItem[],
  invariants: VerifyResult["invariants"]
): Promise<boolean> {
  for (const batch of chunks(appliedItems, DEFAULT_BATCH_SIZE)) {
    const ok = await verifyAppliedBatch(db, run, batch, invariants);
    if (!ok) return false;
  }
  return true;
}

async function countOrphanAssignments(
  db: BackfillDb,
  runId: string,
  appliedItems: VerificationItem[]
): Promise<number> {
  const orphanWhere: Prisma.ComplaintWhereInput = {
    classificationAssignmentRunId: runId,
    classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL,
  };
  if (appliedItems.length > 0) {
    orphanWhere.id = { notIn: appliedItems.map((i) => i.complaintId) };
  }
  return db.complaint.count({ where: orphanWhere });
}

async function buildTaxonomyVerificationNote(
  db: BackfillDb,
  run: VerificationRun,
  invariants: VerifyResult["invariants"]
): Promise<string | undefined> {
  const currentTaxonomy = await loadActiveTaxonomy(db);
  const currentFingerprint = computeTaxonomyFingerprint(currentTaxonomy);
  if (currentFingerprint === run.taxonomyFingerprint) return undefined;
  invariants.push({
    code: BACKFILL_ERROR_CODES.CURRENT_TAXONOMY_DIFFERS_FROM_APPLIED_FINGERPRINT,
    ok: true,
    detail: "informative only; data not mutated",
  });
  return BACKFILL_ERROR_CODES.CURRENT_TAXONOMY_DIFFERS_FROM_APPLIED_FINGERPRINT;
}

function resolveVerifiedApplyStatus(input: {
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  plannedCount: number;
}): BackfillRunStatus {
  if (input.failedCount > 0 || input.plannedCount > 0) {
    if (input.appliedCount > 0) return BACKFILL_RUN_STATUSES.PARTIALLY_APPLIED;
    return BACKFILL_RUN_STATUSES.FAILED;
  }
  return BACKFILL_RUN_STATUSES.APPLIED;
}

async function persistVerificationOutcome(input: {
  db: BackfillDb;
  run: VerificationRun;
  ok: boolean;
  mode: "apply" | "rollback";
  partitioned: PartitionedVerificationItems;
}): Promise<BackfillRunStatus> {
  if (input.mode === "rollback") {
    return input.run.status as BackfillRunStatus;
  }

  if (!input.ok) {
    await input.db.classificationBackfillRun.update({
      where: { id: input.run.id },
      data: { status: BACKFILL_RUN_STATUSES.VERIFY_FAILED },
    });
    return BACKFILL_RUN_STATUSES.VERIFY_FAILED;
  }

  if (input.run.status === BACKFILL_RUN_STATUSES.VERIFY_FAILED) {
    const restored = resolveVerifiedApplyStatus({
      appliedCount: input.partitioned.appliedItems.length,
      skippedCount: input.partitioned.skippedItems.length,
      failedCount: input.partitioned.failedItems.length,
      plannedCount: (
        await input.db.classificationBackfillItem.count({
          where: { runId: input.run.id, result: BACKFILL_ITEM_RESULTS.PLANNED },
        })
      ),
    });
    await input.db.classificationBackfillRun.update({
      where: { id: input.run.id },
      data: { status: restored },
    });
    return restored;
  }

  return input.run.status as BackfillRunStatus;
}

async function verifyRollbackOutcome(
  db: BackfillDb,
  run: VerificationRun,
  partitioned: PartitionedVerificationItems
): Promise<VerifyResult["invariants"]> {
  const originalApplyRunId =
    run.operation === BACKFILL_OPERATIONS.ROLLBACK && run.rollbackOfRunId
      ? run.rollbackOfRunId
      : run.id;

  const rolledBack = partitioned.rolledBackItems;
  let clearedOk = true;
  for (const batch of chunks(rolledBack, DEFAULT_BATCH_SIZE)) {
    const complaints = await db.complaint.findMany({
      where: { id: { in: batch.map((i) => i.complaintId) } },
      select: {
        id: true,
        classificationAssignmentRunId: true,
        classificationAssignmentSource: true,
      },
    });
    const byId = new Map(complaints.map((c) => [c.id, c]));
    for (const item of batch) {
      const c = byId.get(item.complaintId);
      if (
        c &&
        c.classificationAssignmentRunId === originalApplyRunId &&
        c.classificationAssignmentSource === CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL
      ) {
        clearedOk = false;
        break;
      }
    }
    if (!clearedOk) break;
  }

  return [
    {
      code: "ROLLBACK_TERMINAL_STATE_PRESERVED",
      ok: true,
      detail: run.status,
    },
    {
      code: "ROLLED_BACK_ITEMS_CLEARED",
      ok: clearedOk,
      detail: String(rolledBack.length),
    },
  ];
}

function buildVerifyResult(input: {
  run: VerificationRun;
  ok: boolean;
  status: BackfillRunStatus;
  invariants: VerifyResult["invariants"];
  remainingUnclassifiedInPeriod: number;
  taxonomyNote?: string;
}): VerifyResult {
  return {
    mode: "verify",
    runId: input.run.id,
    ok: input.ok,
    status: input.status,
    invariants: input.invariants,
    remainingUnclassifiedInPeriod: input.remainingUnclassifiedInPeriod,
    taxonomyNote: input.taxonomyNote,
  };
}

export async function verifyHistoricalClassificationBackfill(
  db: BackfillDb,
  input: { runId: string }
): Promise<VerifyResult> {
  const run = await loadVerificationRun(db, input.runId);
  const items = await loadVerificationItems(db, run.id);
  const partitioned = partitionVerificationItems(items);

  const remainingUnclassifiedInPeriod = await db.complaint.count({
    where: {
      ...effectiveDateWhere(run.periodFrom, run.periodToExclusive),
      classificationId: null,
      classificationAssignmentSource: null,
    },
  });

  if (isRollbackTerminalOrActive(run)) {
    const invariants = await verifyRollbackOutcome(db, run, partitioned);
    const ok = invariants.every((i) => i.ok);
    const status = await persistVerificationOutcome({
      db,
      run,
      ok,
      mode: "rollback",
      partitioned,
    });
    await writeAuditLog(db, {
      action: "CLASSIFICATION_HISTORICAL_BACKFILL_VERIFIED",
      entityType: "ClassificationBackfillRun",
      entityId: run.id,
      actor: AUDIT_ACTOR_SYSTEM,
      metadata: {
        runId: run.id,
        verificationMode: "rollback",
        status,
        ok,
      },
    });
    return buildVerifyResult({
      run,
      ok,
      status,
      invariants,
      remainingUnclassifiedInPeriod,
    });
  }

  if (!isApplyVerifiableState(run)) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_RUN_NOT_FOUND,
      "تشغيل الـBackfill غير قابل للتحقق في حالته الحالية"
    );
  }

  const invariants = buildApplyCountInvariants(run, items, partitioned);
  const appliedOk = await verifyAppliedItems(db, run, partitioned.appliedItems, invariants);
  invariants.push({ code: "APPLIED_ITEMS_MATCH_COMPLAINTS", ok: appliedOk });

  const orphanComplaints = await countOrphanAssignments(db, run.id, partitioned.appliedItems);
  invariants.push({
    code: "NO_ORPHAN_COMPLAINTS",
    ok: orphanComplaints === 0,
    detail: String(orphanComplaints),
  });

  const taxonomyNote = await buildTaxonomyVerificationNote(db, run, invariants);
  const ok = invariants.every((i) => i.ok);
  const status = await persistVerificationOutcome({
    db,
    run,
    ok,
    mode: "apply",
    partitioned,
  });

  await writeAuditLog(db, {
    action: "CLASSIFICATION_HISTORICAL_BACKFILL_VERIFIED",
    entityType: "ClassificationBackfillRun",
    entityId: run.id,
    actor: AUDIT_ACTOR_SYSTEM,
    metadata: {
      runId: run.id,
      verificationMode: "apply",
      manifestHash: run.manifestHash,
      taxonomyFingerprint: run.taxonomyFingerprint,
      periodFrom: run.periodFrom.toISOString(),
      periodTo: run.periodToExclusive.toISOString(),
      eligibleCount: run.eligibleCount,
      plannedCount: run.plannedCount,
      appliedCount: run.appliedCount,
      skippedCount: run.skippedCount,
      failedCount: run.failedCount,
      batchSize: run.batchSize,
      ok,
    },
  });

  return buildVerifyResult({
    run,
    ok,
    status,
    invariants,
    remainingUnclassifiedInPeriod,
    taxonomyNote,
  });
}



type RollbackItemDecision =
  | { action: "SKIP"; reason: string }
  | { action: "ROLLBACK" };

async function markRollbackItemSkipped(
  tx: Prisma.TransactionClient,
  itemId: string,
  reason: string
): Promise<void> {
  await tx.classificationBackfillItem.update({
    where: { id: itemId },
    data: {
      result: BACKFILL_ITEM_RESULTS.ROLLBACK_SKIPPED,
      skipReason: reason,
      rolledBackAt: new Date(),
    },
  });
}

function evaluateRollbackItem(input: {
  complaint:
    | {
        id: string;
        version: number;
        isDeleted: boolean;
        classificationId: string | null;
        classificationAssignmentSource: string | null;
        classificationAssignmentRunId: string | null;
      }
    | null;
  item: {
    targetClassificationId: string;
    appliedVersion: number | null;
  };
  originalRunId: string;
}): RollbackItemDecision {
  const { complaint, item, originalRunId } = input;
  if (!complaint || complaint.isDeleted) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.ROLLBACK_SKIPPED_DELETED };
  }
  if (complaint.classificationAssignmentSource === CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.ROLLBACK_SKIPPED_MANUAL_CHANGE };
  }
  if (
    complaint.classificationId !== item.targetClassificationId ||
    complaint.classificationAssignmentSource !==
      CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL ||
    complaint.classificationAssignmentRunId !== originalRunId
  ) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.ROLLBACK_SKIPPED_CLASSIFICATION_CHANGED };
  }
  if (item.appliedVersion != null && complaint.version !== item.appliedVersion) {
    return { action: "SKIP", reason: BACKFILL_SKIP_REASONS.ROLLBACK_SKIPPED_VERSION_CHANGED };
  }
  return { action: "ROLLBACK" };
}

function resolveRollbackStatus(rolledBackCount: number, skippedCount: number): BackfillRunStatus {
  if (skippedCount > 0) {
    return BACKFILL_RUN_STATUSES.PARTIALLY_ROLLED_BACK;
  }
  return BACKFILL_RUN_STATUSES.ROLLED_BACK;
}

export async function rollbackHistoricalClassificationBackfill(
  db: BackfillDb,
  input: {
    runId: string;
    confirm?: string;
    batchSize?: number;
    actor?: string;
  }
): Promise<RollbackResult> {
  if (!input.confirm) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_CONFIRMATION_REQUIRED,
      "رمز تأكيد التراجع مطلوب"
    );
  }

  const batchSize = validateBatchSize(input.batchSize ?? DEFAULT_BATCH_SIZE);
  const actor = input.actor ?? AUDIT_ACTOR_SYSTEM;
  const original = await db.classificationBackfillRun.findUnique({ where: { id: input.runId } });
  if (!original) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_RUN_NOT_FOUND,
      "تشغيل الـBackfill غير موجود"
    );
  }

  const expectedToken = buildRollbackToken({
    runId: original.id,
    manifestHash: original.manifestHash,
    appliedCount: original.appliedCount,
  });
  if (input.confirm !== expectedToken) {
    throw new HistoricalBackfillError(
      BACKFILL_ERROR_CODES.BACKFILL_CONFIRMATION_INVALID,
      "رمز تأكيد التراجع غير صحيح"
    );
  }

  const rollbackRun = await db.classificationBackfillRun.create({
    data: {
      operation: BACKFILL_OPERATIONS.ROLLBACK,
      status: BACKFILL_RUN_STATUSES.ROLLING_BACK,
      periodFrom: original.periodFrom,
      periodToExclusive: original.periodToExclusive,
      taxonomyFingerprint: original.taxonomyFingerprint,
      manifestHash: original.manifestHash,
      eligibleCount: original.eligibleCount,
      plannedCount: original.appliedCount,
      batchSize,
      actor,
      rollbackOfRunId: original.id,
    },
  });

  const appliedItems = await db.classificationBackfillItem.findMany({
    where: { runId: original.id, result: BACKFILL_ITEM_RESULTS.APPLIED },
    orderBy: { complaintId: "asc" },
  });

  let rolledBackCount = 0;
  let skippedCount = 0;

  for (const batch of chunks(appliedItems, batchSize)) {
    await db.$transaction(async (tx) => {
      for (const item of batch) {
        const complaint = await tx.complaint.findUnique({
          where: { id: item.complaintId },
          select: {
            id: true,
            version: true,
            isDeleted: true,
            classificationId: true,
            classificationAssignmentSource: true,
            classificationAssignmentRunId: true,
            sourceDetail: true,
          },
        });

        const decision = evaluateRollbackItem({
          complaint,
          item,
          originalRunId: original.id,
        });
        if (decision.action === "SKIP") {
          await markRollbackItemSkipped(tx, item.id, decision.reason);
          skippedCount += 1;
          continue;
        }

        const updateResult = await tx.complaint.updateMany({
          where: {
            id: complaint!.id,
            version: item.appliedVersion ?? complaint!.version,
            isDeleted: false,
            classificationId: item.targetClassificationId,
            classificationAssignmentSource: CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL,
            classificationAssignmentRunId: original.id,
          },
          data: {
            classificationId: item.previousClassificationId,
            categoryId: item.previousCategoryId ?? null,
            classificationAssignmentSource: item.previousAssignmentSource,
            classificationAssignedAt: item.previousAssignedAt,
            classificationAssignedBy: item.previousAssignedBy,
            classificationTaxonomyFingerprint: item.previousTaxonomyFingerprint,
            classificationAssignmentRunId: item.previousAssignmentRunId,
            version: { increment: 1 },
          },
        });

        if (updateResult.count !== 1) {
          await markRollbackItemSkipped(
            tx,
            item.id,
            BACKFILL_SKIP_REASONS.ROLLBACK_SKIPPED_VERSION_CHANGED
          );
          skippedCount += 1;
          continue;
        }

        await tx.classificationBackfillItem.update({
          where: { id: item.id },
          data: {
            result: BACKFILL_ITEM_RESULTS.ROLLED_BACK,
            rolledBackAt: new Date(),
            skipReason: null,
          },
        });
        rolledBackCount += 1;
      }
    });
  }

  const status = resolveRollbackStatus(rolledBackCount, skippedCount);

  await db.classificationBackfillRun.update({
    where: { id: rollbackRun.id },
    data: {
      status,
      appliedCount: rolledBackCount,
      skippedCount,
      completedAt: new Date(),
    },
  });

  await db.classificationBackfillRun.update({
    where: { id: original.id },
    data: {
      status,
    },
  });

  await writeAuditLog(db, {
    action: "CLASSIFICATION_HISTORICAL_BACKFILL_ROLLED_BACK",
    entityType: "ClassificationBackfillRun",
    entityId: rollbackRun.id,
    actor,
    metadata: {
      runId: rollbackRun.id,
      originalRunId: original.id,
      manifestHash: original.manifestHash,
      taxonomyFingerprint: original.taxonomyFingerprint,
      periodFrom: original.periodFrom.toISOString(),
      periodTo: original.periodToExclusive.toISOString(),
      eligibleCount: original.eligibleCount,
      plannedCount: original.appliedCount,
      appliedCount: rolledBackCount,
      skippedCount,
      failedCount: 0,
      batchSize,
      completedAt: new Date().toISOString(),
    },
  });

  return {
    mode: "rollback",
    runId: rollbackRun.id,
    originalRunId: original.id,
    status,
    rolledBackCount,
    skippedCount,
  };
}
