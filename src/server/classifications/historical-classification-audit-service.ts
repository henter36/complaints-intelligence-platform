import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import { parseClassificationKeywords } from "./classification-keywords";
import {
  CLASSIFICATION_ASSIGNMENT_SOURCES,
  buildClassificationAssignmentMetadata,
} from "./classification-assignment";
import { compareCodeUnits } from "./canonical-string-order";
import { stableStringify } from "./historical-classification-backfill";
import {
  computeTaxonomyFingerprint,
  type TaxonomyFingerprintClassification,
} from "./taxonomy-fingerprint";

export const CLASSIFICATION_AUDIT_SCHEMA_VERSION = 1;
export const CLASSIFICATION_AUDIT_ACTOR = "historical-classification-cleanup";
export const DEFAULT_AUDIT_BATCH_SIZE = 200;
export const MAX_AUDIT_BATCH_SIZE = 500;

export const AUDIT_RESULTS = {
  KEEP: "KEEP",
  CORRECT_HIGH_CONFIDENCE: "CORRECT_HIGH_CONFIDENCE",
  REVIEW: "REVIEW",
  AMBIGUOUS: "AMBIGUOUS",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
  INVALID_TAXONOMY_REFERENCE: "INVALID_TAXONOMY_REFERENCE",
} as const;

export type AuditResultCode = (typeof AUDIT_RESULTS)[keyof typeof AUDIT_RESULTS];

export const AUDIT_REASON_CODES = {
  EXACT_SOURCE_DETAIL_KEYWORD: "EXACT_SOURCE_DETAIL_KEYWORD",
  MULTI_FIELD_KEYWORD_AGREEMENT: "MULTI_FIELD_KEYWORD_AGREEMENT",
  DESCRIPTION_STRONGLY_CONTRADICTS_CURRENT: "DESCRIPTION_STRONGLY_CONTRADICTS_CURRENT",
  SUBJECT_DESCRIPTION_AGREEMENT: "SUBJECT_DESCRIPTION_AGREEMENT",
  CURRENT_CLASSIFICATION_ALREADY_SUPPORTED: "CURRENT_CLASSIFICATION_ALREADY_SUPPORTED",
  MULTIPLE_TARGETS: "MULTIPLE_TARGETS",
  NO_STRONG_TARGET: "NO_STRONG_TARGET",
  TARGET_INACTIVE: "TARGET_INACTIVE",
  CATEGORY_CLASSIFICATION_MISMATCH: "CATEGORY_CLASSIFICATION_MISMATCH",
} as const;

export type AuditReasonCode = (typeof AUDIT_REASON_CODES)[keyof typeof AUDIT_REASON_CODES];

export const AUDIT_SKIP_REASONS = {
  VERSION_CHANGED: "VERSION_CHANGED",
  TARGET_CHANGED: "TARGET_CHANGED",
  DELETED_AFTER_PREVIEW: "DELETED_AFTER_PREVIEW",
  TARGET_INACTIVE: "TARGET_INACTIVE",
  CATEGORY_CLASSIFICATION_MISMATCH: "CATEGORY_CLASSIFICATION_MISMATCH",
  ROLLBACK_SKIPPED_VERSION_CHANGED: "ROLLBACK_SKIPPED_VERSION_CHANGED",
  ROLLBACK_SKIPPED_TARGET_CHANGED: "ROLLBACK_SKIPPED_TARGET_CHANGED",
  ROLLBACK_SKIPPED_DELETED: "ROLLBACK_SKIPPED_DELETED",
} as const;

export const AUDIT_ERROR_CODES = {
  MANIFEST_REQUIRED: "CLASSIFICATION_AUDIT_MANIFEST_REQUIRED",
  MANIFEST_NOT_FOUND: "CLASSIFICATION_AUDIT_MANIFEST_NOT_FOUND",
  MANIFEST_INVALID: "CLASSIFICATION_AUDIT_MANIFEST_INVALID",
  MANIFEST_HASH_MISMATCH: "CLASSIFICATION_AUDIT_MANIFEST_HASH_MISMATCH",
  CONFIRMATION_REQUIRED: "CLASSIFICATION_AUDIT_CONFIRMATION_REQUIRED",
  CONFIRMATION_INVALID: "CLASSIFICATION_AUDIT_CONFIRMATION_INVALID",
  TAXONOMY_CHANGED: "CLASSIFICATION_AUDIT_TAXONOMY_CHANGED",
  DATABASE_CHANGED: "CLASSIFICATION_AUDIT_DATABASE_CHANGED",
  BACKUP_REQUIRED: "CLASSIFICATION_AUDIT_BACKUP_REQUIRED",
  BACKUP_FAILED: "CLASSIFICATION_AUDIT_BACKUP_FAILED",
  RUN_NOT_FOUND: "CLASSIFICATION_AUDIT_RUN_NOT_FOUND",
  INVALID_BATCH_SIZE: "CLASSIFICATION_AUDIT_INVALID_BATCH_SIZE",
  ALREADY_APPLIED: "CLASSIFICATION_AUDIT_ALREADY_APPLIED",
  VERIFY_FAILED: "CLASSIFICATION_AUDIT_VERIFY_FAILED",
} as const;

export class HistoricalClassificationAuditError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HistoricalClassificationAuditError";
  }
}

export type AuditTaxonomyClassification = TaxonomyFingerprintClassification;

export type AuditComplaint = {
  id: string;
  externalId: string | null;
  sourceDetail: string | null;
  subject: string;
  description: string | null;
  classificationId: string | null;
  categoryId: string | null;
  classificationAssignmentSource: string | null;
  classificationAssignedAt: Date | null;
  classificationAssignedBy: string | null;
  classificationTaxonomyFingerprint: string | null;
  classificationAssignmentRunId: string | null;
  version: number;
  updatedAt: Date;
  isDeleted: boolean;
};

export type EvidenceDecision = {
  result: AuditResultCode;
  reasonCode: AuditReasonCode;
  confidence: number;
  targetClassificationId: string | null;
  targetCategoryId: string | null;
  evidenceSummary: string;
};

export type AuditManifestCorrection = {
  complaintId: string;
  expectedVersion: number;
  previousClassificationId: string | null;
  previousCategoryId: string | null;
  previousAssignmentSource: string | null;
  previousAssignedAt: string | null;
  previousAssignedBy: string | null;
  previousTaxonomyFingerprint: string | null;
  previousAssignmentRunId: string | null;
  targetClassificationId: string;
  targetCategoryId: string;
  confidence: number;
  reasonCode: AuditReasonCode;
  evidenceSummary: string;
  complaintStateHash: string;
  taxonomyFingerprint: string;
};

export type DatabaseFingerprint = {
  totalComplaintCount: number;
  activeComplaintCount: number;
  maxUpdatedAt: string | null;
  complaintStateHash: string;
  taxonomyFingerprint: string;
};

export type DistributionEntry = {
  classificationId: string | null;
  classificationName: string;
  categoryId: string | null;
  categoryName: string;
  before: number;
  after: number;
  difference: number;
};

export type CategoryDistributionEntry = {
  categoryId: string | null;
  categoryName: string;
  before: number;
  after: number;
  difference: number;
};

export type AuditGroupSummary = {
  sourceDetailHash: string;
  currentClassificationId: string | null;
  currentCategoryId: string | null;
  count: number;
  result: AuditResultCode;
  targetClassificationId: string | null;
  targetCategoryId: string | null;
  confidence: number;
  reasonCode: AuditReasonCode;
};

export type UnusedClassificationCandidate = {
  classificationId: string;
  classificationName: string;
  categoryId: string;
  categoryName: string;
};

export type HistoricalClassificationAuditManifest = {
  schemaVersion: number;
  generatedAt: string;
  databaseFingerprint: DatabaseFingerprint;
  taxonomyFingerprint: string;
  totalComplaints: number;
  keepCount: number;
  correctionCount: number;
  reviewCount: number;
  ambiguousCount: number;
  insufficientEvidenceCount: number;
  invalidReferenceCount: number;
  uniqueSourceDetailGroups: number;
  misclassifiedSourceDetailGroups: number;
  categoryClassificationMismatchCountBefore: number;
  unusedClassificationCandidates: UnusedClassificationCandidate[];
  distribution: DistributionEntry[];
  categoryDistribution: CategoryDistributionEntry[];
  groups: AuditGroupSummary[];
  corrections: AuditManifestCorrection[];
  manifestHash: string;
  confirmationToken: string;
};

export type AuditDryRunResult = {
  mode: "dry-run";
  manifestPath: string;
  manifestHash: string;
  confirmationToken: string;
  taxonomyFingerprint: string;
  totalComplaints: number;
  counts: Record<AuditResultCode, number>;
  uniqueSourceDetailGroups: number;
  misclassifiedSourceDetailGroups: number;
  categoryClassificationMismatchCountBefore: number;
  unusedClassificationCandidates: UnusedClassificationCandidate[];
  distribution: DistributionEntry[];
  categoryDistribution: CategoryDistributionEntry[];
  performance: AuditPerformance;
};

export type AuditPerformance = {
  complaintsScanned: number;
  groupsAnalyzed: number;
  candidateCorrections: number;
  databaseQueries: number;
  elapsedMs: number;
  heapUsedBytes: number;
  rssBytes: number;
};

export type AuditApplyResult = {
  mode: "apply";
  runId: string;
  status: string;
  plannedCount: number;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  backupName: string;
  rollbackToken: string;
  elapsedMs: number;
  performance: {
    databaseQueries: number;
    elapsedMs: number;
    heapUsedBytes: number;
    rssBytes: number;
  };
};

export type AuditVerifyResult = {
  mode: "verify";
  runId: string;
  ok: boolean;
  invariants: Array<{ code: string; ok: boolean; detail: string }>;
  totalComplaintsBefore: number;
  totalComplaintsAfter: number;
  activeComplaintsBefore: number;
  activeComplaintsAfter: number;
  appliedCount: number;
  distribution: DistributionEntry[];
  categoryDistribution: CategoryDistributionEntry[];
  categoryClassificationMismatchCountBefore: number;
  categoryClassificationMismatchCountAfter: number;
  knownRegressions: Array<{
    sourceDetailLabel: string;
    expectedClassification: string;
    expectedCategory: string;
    matchedCount: number;
    correctCount: number;
    ok: boolean;
  }>;
};

export type AuditRollbackResult = {
  mode: "rollback";
  runId: string;
  originalRunId: string;
  status: string;
  rolledBackCount: number;
  skippedCount: number;
};

export type BackupReceipt = { backupName: string; verified: true };
export type AuditDb = PrismaClient;

type IndexedTaxonomy = {
  allById: Map<string, AuditTaxonomyClassification>;
  active: AuditTaxonomyClassification[];
  exactKeywordTargets: Map<string, AuditTaxonomyClassification[]>;
  evidencePhrases: Map<string, string[]>;
};

export type ScoredCandidate = {
  classification: AuditTaxonomyClassification;
  score: number;
  fields: Set<"subject" | "description">;
  phrases: Set<string>;
  descriptionPhraseCount: number;
};

const KNOWN_REGRESSIONS = [
  {
    sourceDetail: "أجزاء القرآن",
    classificationName: "القرآن والبرامج الدينية",
    categoryName: "التوجية والارشاد",
  },
  {
    sourceDetail: "سجادة صلاة",
    classificationName: "المستلزمات الدينية",
    categoryName: "التوجية والارشاد",
  },
  {
    sourceDetail: "قلة الكتب في مكتبة السجن",
    classificationName: "المكتبة والقراءة",
    categoryName: "التوجية والارشاد",
  },
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export function validateAuditBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_AUDIT_BATCH_SIZE) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.INVALID_BATCH_SIZE,
      `حجم الدفعة يجب أن يكون بين 1 و ${MAX_AUDIT_BATCH_SIZE}`
    );
  }
  return value;
}

function normalizeEvidenceText(value: string | null | undefined): string {
  if (!value) return "";
  return normalizeClassificationKeyword(value)
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function phraseTokenCount(value: string): number {
  return value ? value.split(" ").length : 0;
}

function phraseOccurrences(text: string, phrase: string): number {
  if (!text || !phrase) return 0;
  const textTokens = text.split(" ");
  const phraseTokens = phrase.split(" ");
  let count = 0;
  for (let index = 0; index <= textTokens.length - phraseTokens.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < phraseTokens.length; offset += 1) {
      if (textTokens[index + offset] !== phraseTokens[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) count += 1;
  }
  return count;
}

function safeKeywords(classification: AuditTaxonomyClassification): string[] {
  try {
    return parseClassificationKeywords(classification.keywords ?? []);
  } catch {
    return [];
  }
}

export function buildAuditTaxonomyIndex(
  taxonomy: readonly AuditTaxonomyClassification[]
): IndexedTaxonomy {
  const allById = new Map(taxonomy.map((classification) => [classification.id, classification]));
  const active = taxonomy.filter(
    (classification) =>
      classification.isActive &&
      !classification.isDeleted &&
      classification.category.isActive &&
      !classification.category.isDeleted
  );
  const exactKeywordTargets = new Map<string, AuditTaxonomyClassification[]>();
  const evidencePhrases = new Map<string, string[]>();

  for (const classification of active) {
    const phrases = new Set<string>();
    for (const keyword of safeKeywords(classification)) {
      const normalized = normalizeEvidenceText(keyword);
      if (!normalized) continue;
      phrases.add(normalized);
      const existing = exactKeywordTargets.get(normalized) ?? [];
      existing.push(classification);
      exactKeywordTargets.set(normalized, existing);
    }
    const normalizedName = normalizeEvidenceText(classification.nameAr);
    if (normalizedName && normalizedName !== "-") phrases.add(normalizedName);
    evidencePhrases.set(classification.id, [...phrases].sort(compareCodeUnits));
  }

  return { allById, active, exactKeywordTargets, evidencePhrases };
}

function scorePhraseEvidence(
  subject: string,
  description: string,
  phrase: string
): {
  score: number;
  subjectMatched: boolean;
  descriptionMatched: boolean;
} {
  const tokenCount = phraseTokenCount(phrase);
  if (tokenCount === 1 && phrase.length < 5) {
    return { score: 0, subjectMatched: false, descriptionMatched: false };
  }
  const subjectCount = Math.min(phraseOccurrences(subject, phrase), 2);
  const descriptionCount = Math.min(phraseOccurrences(description, phrase), 3);
  const subjectWeight = tokenCount >= 2 ? 4 : 2;
  const descriptionWeight = tokenCount >= 2 ? 3 : 1;
  return {
    score: subjectCount * subjectWeight + descriptionCount * descriptionWeight,
    subjectMatched: subjectCount > 0,
    descriptionMatched: descriptionCount > 0,
  };
}

function scoreClassificationEvidence(
  classification: AuditTaxonomyClassification,
  phrases: readonly string[],
  subject: string,
  description: string
): ScoredCandidate | null {
  let score = 0;
  let descriptionPhraseCount = 0;
  const fields = new Set<"subject" | "description">();
  const matchedPhrases = new Set<string>();
  for (const phrase of phrases) {
    const evidence = scorePhraseEvidence(subject, description, phrase);
    score += evidence.score;
    if (evidence.subjectMatched) fields.add("subject");
    if (evidence.descriptionMatched) {
      descriptionPhraseCount += 1;
      fields.add("description");
    }
    if (evidence.subjectMatched || evidence.descriptionMatched) matchedPhrases.add(phrase);
  }
  if (score === 0) return null;
  return {
    classification,
    score,
    fields,
    phrases: matchedPhrases,
    descriptionPhraseCount,
  };
}

export function scoreSemanticCandidates(
  complaint: Pick<AuditComplaint, "subject" | "description">,
  index: IndexedTaxonomy
): ScoredCandidate[] {
  const subject = normalizeEvidenceText(complaint.subject);
  const description = normalizeEvidenceText(complaint.description);
  const scores: ScoredCandidate[] = [];

  for (const classification of index.active) {
    const candidate = scoreClassificationEvidence(
      classification,
      index.evidencePhrases.get(classification.id) ?? [],
      subject,
      description
    );
    if (candidate) scores.push(candidate);
  }

  return scores.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return compareCodeUnits(left.classification.id, right.classification.id);
  });
}

function unclassifiedDecision(): EvidenceDecision {
  return {
    result: AUDIT_RESULTS.KEEP,
    reasonCode: AUDIT_REASON_CODES.NO_STRONG_TARGET,
    confidence: 1,
    targetClassificationId: null,
    targetCategoryId: null,
    evidenceSummary: "unclassified row is outside historical-correction scope",
  };
}

function noEvidenceDecision(currentReferenceValid: boolean): EvidenceDecision {
  if (!currentReferenceValid) {
    return {
      result: AUDIT_RESULTS.INVALID_TAXONOMY_REFERENCE,
      reasonCode: AUDIT_REASON_CODES.TARGET_INACTIVE,
      confidence: 0,
      targetClassificationId: null,
      targetCategoryId: null,
      evidenceSummary: "no qualifying normalized phrase evidence",
    };
  }
  return {
    result: AUDIT_RESULTS.INSUFFICIENT_EVIDENCE,
    reasonCode: AUDIT_REASON_CODES.NO_STRONG_TARGET,
    confidence: 0,
    targetClassificationId: null,
    targetCategoryId: null,
    evidenceSummary: "no qualifying normalized phrase evidence",
  };
}

function ambiguousSemanticDecision(best: ScoredCandidate, lead: number): EvidenceDecision {
  return {
    result: AUDIT_RESULTS.AMBIGUOUS,
    reasonCode: AUDIT_REASON_CODES.MULTIPLE_TARGETS,
    confidence: 0,
    targetClassificationId: null,
    targetCategoryId: null,
    evidenceSummary: `semantic tie topScore=${best.score} lead=${lead}`,
  };
}

function currentClassificationDecision(best: ScoredCandidate): EvidenceDecision {
  return {
    result: AUDIT_RESULTS.KEEP,
    reasonCode: AUDIT_REASON_CODES.CURRENT_CLASSIFICATION_ALREADY_SUPPORTED,
    confidence: Math.min(0.99, 0.7 + best.score / 50),
    targetClassificationId: best.classification.id,
    targetCategoryId: best.classification.category.id,
    evidenceSummary: `current assignment leads score=${best.score} fields=${best.fields.size}`,
  };
}

function strongSemanticDecision(
  best: ScoredCandidate,
  lead: number,
  multiFieldStrong: boolean
): EvidenceDecision {
  return {
    result: AUDIT_RESULTS.CORRECT_HIGH_CONFIDENCE,
    reasonCode: multiFieldStrong
      ? AUDIT_REASON_CODES.SUBJECT_DESCRIPTION_AGREEMENT
      : AUDIT_REASON_CODES.DESCRIPTION_STRONGLY_CONTRADICTS_CURRENT,
    confidence: multiFieldStrong ? 0.95 : 0.92,
    targetClassificationId: best.classification.id,
    targetCategoryId: best.classification.category.id,
    evidenceSummary: `local phrases=${best.phrases.size} fields=${best.fields.size} score=${best.score} lead=${lead}`,
  };
}

function reviewDecision(best: ScoredCandidate, lead: number): EvidenceDecision {
  return {
    result: AUDIT_RESULTS.REVIEW,
    reasonCode: AUDIT_REASON_CODES.NO_STRONG_TARGET,
    confidence: Math.min(0.89, 0.5 + best.score / 50),
    targetClassificationId: best.classification.id,
    targetCategoryId: best.classification.category.id,
    evidenceSummary: `candidate below correction threshold score=${best.score} lead=${lead}`,
  };
}

function isAmbiguousSemanticLead(
  runnerUp: ScoredCandidate | undefined,
  lead: number
): boolean {
  return Boolean(runnerUp && runnerUp.score >= 3 && lead <= 1);
}

function isMultiFieldStrong(best: ScoredCandidate, lead: number): boolean {
  const subjectAndDescription =
    best.fields.has("subject") && best.fields.has("description");
  return subjectAndDescription && best.phrases.size >= 2 && best.score >= 8 && lead >= 4;
}

function isDescriptionStrong(best: ScoredCandidate, lead: number): boolean {
  return best.descriptionPhraseCount >= 3 && best.score >= 9 && lead >= 4;
}

function evaluateSemanticCandidates(
  complaint: AuditComplaint,
  currentReferenceValid: boolean,
  scores: readonly ScoredCandidate[]
): EvidenceDecision {
  const best = scores[0];
  const runnerUp = scores[1];
  if (!best) return noEvidenceDecision(currentReferenceValid);

  const lead = best.score - (runnerUp?.score ?? 0);
  if (isAmbiguousSemanticLead(runnerUp, lead)) return ambiguousSemanticDecision(best, lead);
  if (best.classification.id === complaint.classificationId) {
    return currentClassificationDecision(best);
  }

  const multiFieldStrong = isMultiFieldStrong(best, lead);
  if (multiFieldStrong || isDescriptionStrong(best, lead)) {
    return strongSemanticDecision(best, lead, multiFieldStrong);
  }
  return reviewDecision(best, lead);
}

function isCurrentReferenceValid(
  complaint: Pick<AuditComplaint, "classificationId" | "categoryId">,
  index: IndexedTaxonomy
): boolean {
  if (!complaint.classificationId) return true;
  const current = index.allById.get(complaint.classificationId);
  return Boolean(
    current &&
      current.isActive &&
      !current.isDeleted &&
      current.category.isActive &&
      !current.category.isDeleted &&
      complaint.categoryId === current.category.id
  );
}

function exactSourceDecision(
  complaint: AuditComplaint,
  index: IndexedTaxonomy
): EvidenceDecision | null {
  const sourceDetail = normalizeEvidenceText(complaint.sourceDetail);
  if (!sourceDetail) return null;
  const targets = index.exactKeywordTargets.get(sourceDetail) ?? [];
  if (targets.length > 1) {
    return {
      result: AUDIT_RESULTS.AMBIGUOUS,
      reasonCode: AUDIT_REASON_CODES.MULTIPLE_TARGETS,
      confidence: 0,
      targetClassificationId: null,
      targetCategoryId: null,
      evidenceSummary: `exact-source-detail targets=${targets.length}`,
    };
  }
  if (targets.length === 0) return null;
  const target = targets[0]!;
  if (
    complaint.classificationId === target.id &&
    complaint.categoryId === target.category.id
  ) {
    return {
      result: AUDIT_RESULTS.KEEP,
      reasonCode: AUDIT_REASON_CODES.CURRENT_CLASSIFICATION_ALREADY_SUPPORTED,
      confidence: 1,
      targetClassificationId: target.id,
      targetCategoryId: target.category.id,
      evidenceSummary: "unique exact source-detail keyword supports current assignment",
    };
  }
  return {
    result: AUDIT_RESULTS.CORRECT_HIGH_CONFIDENCE,
    reasonCode:
      complaint.classificationId === target.id
        ? AUDIT_REASON_CODES.CATEGORY_CLASSIFICATION_MISMATCH
        : AUDIT_REASON_CODES.EXACT_SOURCE_DETAIL_KEYWORD,
    confidence: 1,
    targetClassificationId: target.id,
    targetCategoryId: target.category.id,
    evidenceSummary: "unique exact source-detail keyword deterministically selects target",
  };
}

export function evaluateHistoricalClassification(
  complaint: AuditComplaint,
  taxonomyOrIndex: readonly AuditTaxonomyClassification[] | IndexedTaxonomy
): EvidenceDecision {
  const index = Array.isArray(taxonomyOrIndex)
    ? buildAuditTaxonomyIndex(taxonomyOrIndex)
    : (taxonomyOrIndex as IndexedTaxonomy);

  // Unclassified rows belong to the existing historical-backfill workflow.
  if (!complaint.classificationId) return unclassifiedDecision();

  const exact = exactSourceDecision(complaint, index);
  if (exact) return exact;

  const currentReferenceValid = isCurrentReferenceValid(complaint, index);
  const scores = scoreSemanticCandidates(complaint, index);
  return evaluateSemanticCandidates(complaint, currentReferenceValid, scores);
}

export function computeComplaintStateHash(
  complaint: Pick<
    AuditComplaint,
    | "id"
    | "sourceDetail"
    | "subject"
    | "description"
    | "classificationId"
    | "categoryId"
    | "classificationAssignmentSource"
    | "classificationAssignedAt"
    | "classificationAssignedBy"
    | "classificationTaxonomyFingerprint"
    | "classificationAssignmentRunId"
    | "version"
    | "updatedAt"
  >
): string {
  return sha256(
    stableStringify({
      id: complaint.id,
      contentHash: sha256(
        stableStringify({
          sourceDetail: normalizeEvidenceText(complaint.sourceDetail),
          subject: normalizeEvidenceText(complaint.subject),
          description: normalizeEvidenceText(complaint.description),
        })
      ),
      classificationId: complaint.classificationId,
      categoryId: complaint.categoryId,
      classificationAssignmentSource: complaint.classificationAssignmentSource,
      classificationAssignedAt: complaint.classificationAssignedAt?.toISOString() ?? null,
      classificationAssignedBy: complaint.classificationAssignedBy,
      classificationTaxonomyFingerprint: complaint.classificationTaxonomyFingerprint,
      classificationAssignmentRunId: complaint.classificationAssignmentRunId,
      version: complaint.version,
      updatedAt: complaint.updatedAt.toISOString(),
    })
  );
}

export function computeDatabaseFingerprint(input: {
  totalComplaintCount: number;
  complaints: readonly AuditComplaint[];
  taxonomyFingerprint: string;
}): DatabaseFingerprint {
  const state = input.complaints
    .map((complaint) => `${complaint.id}:${computeComplaintStateHash(complaint)}`)
    .sort(compareCodeUnits);
  const maxUpdatedAt = input.complaints.reduce<Date | null>(
    (maximum, complaint) =>
      maximum === null || complaint.updatedAt > maximum ? complaint.updatedAt : maximum,
    null
  );
  return {
    totalComplaintCount: input.totalComplaintCount,
    activeComplaintCount: input.complaints.length,
    maxUpdatedAt: maxUpdatedAt?.toISOString() ?? null,
    complaintStateHash: sha256(state.join("\n")),
    taxonomyFingerprint: input.taxonomyFingerprint,
  };
}

function buildConfirmationToken(manifestHash: string, correctionCount: number): string {
  const digest = sha256(`${manifestHash}|${correctionCount}`).slice(0, 12).toUpperCase();
  return `APPLY-AUDIT-${correctionCount}-${digest}`;
}

export function buildAuditRollbackToken(input: {
  runId: string;
  manifestHash: string;
  appliedCount: number;
}): string {
  const digest = sha256(
    `${input.runId}|${input.manifestHash}|${input.appliedCount}`
  ).slice(0, 12).toUpperCase();
  return `ROLLBACK-AUDIT-${input.appliedCount}-${digest}`;
}

type ManifestUnsigned = Omit<
  HistoricalClassificationAuditManifest,
  "manifestHash" | "confirmationToken"
>;

export function computeAuditManifestHash(manifest: ManifestUnsigned): string {
  const payload = {
    ...manifest,
    corrections: [...manifest.corrections].sort((left, right) =>
      compareCodeUnits(left.complaintId, right.complaintId)
    ),
    groups: [...manifest.groups].sort((left, right) => {
      const a = `${left.sourceDetailHash}|${left.currentClassificationId ?? ""}|${left.currentCategoryId ?? ""}`;
      const b = `${right.sourceDetailHash}|${right.currentClassificationId ?? ""}|${right.currentCategoryId ?? ""}`;
      return compareCodeUnits(a, b);
    }),
  };
  return sha256(stableStringify(payload));
}

function assertManifestPrivateDataAbsent(manifest: HistoricalClassificationAuditManifest): void {
  const forbiddenKeys = [
    "subject",
    "description",
    "sourceDetail",
    "complainantName",
    "complainantIdentifier",
    "complainantPhone",
  ];
  const serialized = JSON.stringify(manifest);
  for (const key of forbiddenKeys) {
    if (serialized.includes(`"${key}"`)) {
      throw new HistoricalClassificationAuditError(
        AUDIT_ERROR_CODES.MANIFEST_INVALID,
        `manifest يحتوي حقلًا محظورًا: ${key}`
      );
    }
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  const stream = createWriteStream(temp, { encoding: "utf8", mode: 0o600 });
  stream.end(`${JSON.stringify(value, null, 2)}\n`);
  await finished(stream);
  renameSync(temp, absolute);
  try {
    chmodSync(absolute, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

export async function loadAuditTaxonomy(db: AuditDb): Promise<AuditTaxonomyClassification[]> {
  return db.classification.findMany({
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

const complaintAuditSelect = {
  id: true,
  externalId: true,
  sourceDetail: true,
  subject: true,
  description: true,
  classificationId: true,
  categoryId: true,
  classificationAssignmentSource: true,
  classificationAssignedAt: true,
  classificationAssignedBy: true,
  classificationTaxonomyFingerprint: true,
  classificationAssignmentRunId: true,
  version: true,
  updatedAt: true,
  isDeleted: true,
} satisfies Prisma.ComplaintSelect;

async function loadActiveComplaints(db: AuditDb): Promise<AuditComplaint[]> {
  return db.complaint.findMany({
    where: { isDeleted: false },
    select: complaintAuditSelect,
    orderBy: { id: "asc" },
  });
}

function sourceGroupKey(complaint: AuditComplaint): string {
  return [
    normalizeEvidenceText(complaint.sourceDetail),
    complaint.classificationId ?? "",
    complaint.categoryId ?? "",
  ].join("|");
}

function buildDistribution(
  complaints: readonly AuditComplaint[],
  corrections: readonly Pick<
    AuditManifestCorrection,
    "complaintId" | "targetClassificationId"
  >[],
  taxonomy: readonly AuditTaxonomyClassification[]
): DistributionEntry[] {
  const taxonomyById = new Map(taxonomy.map((entry) => [entry.id, entry]));
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  const targetByComplaint = new Map(
    corrections.map((correction) => [correction.complaintId, correction.targetClassificationId])
  );
  for (const complaint of complaints) {
    const beforeKey = complaint.classificationId ?? "__UNCLASSIFIED__";
    const afterKey = targetByComplaint.get(complaint.id) ?? beforeKey;
    before.set(beforeKey, (before.get(beforeKey) ?? 0) + 1);
    after.set(afterKey, (after.get(afterKey) ?? 0) + 1);
  }
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys]
    .map((key) => {
      const classification = taxonomyById.get(key);
      const beforeCount = before.get(key) ?? 0;
      const afterCount = after.get(key) ?? 0;
      return {
        classificationId: classification?.id ?? null,
        classificationName: classification?.nameAr ?? "UNCLASSIFIED_OR_MISSING",
        categoryId: classification?.category.id ?? null,
        categoryName: classification?.category.nameAr ?? "UNCLASSIFIED_OR_MISSING",
        before: beforeCount,
        after: afterCount,
        difference: afterCount - beforeCount,
      };
    })
    .sort((left, right) => {
      if (Math.abs(right.difference) !== Math.abs(left.difference)) {
        return Math.abs(right.difference) - Math.abs(left.difference);
      }
      return compareCodeUnits(left.classificationName, right.classificationName);
    });
}

function buildCategoryDistribution(
  complaints: readonly AuditComplaint[],
  corrections: readonly Pick<
    AuditManifestCorrection,
    "complaintId" | "targetCategoryId"
  >[],
  taxonomy: readonly AuditTaxonomyClassification[]
): CategoryDistributionEntry[] {
  const categories = new Map<string, string>();
  for (const classification of taxonomy) {
    categories.set(classification.category.id, classification.category.nameAr);
  }
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  const targetByComplaint = new Map(
    corrections.map((correction) => [correction.complaintId, correction.targetCategoryId])
  );
  for (const complaint of complaints) {
    const beforeKey = complaint.categoryId ?? "__UNCLASSIFIED__";
    const afterKey = targetByComplaint.get(complaint.id) ?? beforeKey;
    before.set(beforeKey, (before.get(beforeKey) ?? 0) + 1);
    after.set(afterKey, (after.get(afterKey) ?? 0) + 1);
  }
  return [...new Set([...before.keys(), ...after.keys()])]
    .map((key) => {
      const beforeCount = before.get(key) ?? 0;
      const afterCount = after.get(key) ?? 0;
      return {
        categoryId: key === "__UNCLASSIFIED__" ? null : key,
        categoryName: categories.get(key) ?? "UNCLASSIFIED_OR_MISSING",
        before: beforeCount,
        after: afterCount,
        difference: afterCount - beforeCount,
      };
    })
    .sort((left, right) => {
      if (Math.abs(right.difference) !== Math.abs(left.difference)) {
        return Math.abs(right.difference) - Math.abs(left.difference);
      }
      return compareCodeUnits(left.categoryName, right.categoryName);
    });
}

function buildPrivateReviewEntry(complaint: AuditComplaint, decision: EvidenceDecision) {
  return {
    complaintId: complaint.id,
    externalId: complaint.externalId,
    sourceDetail: complaint.sourceDetail?.slice(0, 300) ?? null,
    subject: complaint.subject.slice(0, 300),
    description: complaint.description?.slice(0, 600) ?? null,
    currentClassificationId: complaint.classificationId,
    currentCategoryId: complaint.categoryId,
    candidateClassificationId: decision.targetClassificationId,
    candidateCategoryId: decision.targetCategoryId,
    confidence: decision.confidence,
    reasonCode: decision.reasonCode,
    evidenceSummary: decision.evidenceSummary,
  };
}

function emptyResultCounts(): Record<AuditResultCode, number> {
  return {
    KEEP: 0,
    CORRECT_HIGH_CONFIDENCE: 0,
    REVIEW: 0,
    AMBIGUOUS: 0,
    INSUFFICIENT_EVIDENCE: 0,
    INVALID_TAXONOMY_REFERENCE: 0,
  };
}

function groupComplaintsBySource(
  complaints: readonly AuditComplaint[]
): Map<string, AuditComplaint[]> {
  const grouped = new Map<string, AuditComplaint[]>();
  for (const complaint of complaints) {
    const key = sourceGroupKey(complaint);
    const values = grouped.get(key) ?? [];
    values.push(complaint);
    grouped.set(key, values);
  }
  return grouped;
}

function buildCorrection(
  complaint: AuditComplaint,
  decision: EvidenceDecision,
  taxonomyFingerprint: string
): AuditManifestCorrection {
  if (!decision.targetClassificationId || !decision.targetCategoryId) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.MANIFEST_INVALID,
      "قرار تصحيح بلا target صالح"
    );
  }
  return {
    complaintId: complaint.id,
    expectedVersion: complaint.version,
    previousClassificationId: complaint.classificationId,
    previousCategoryId: complaint.categoryId,
    previousAssignmentSource: complaint.classificationAssignmentSource,
    previousAssignedAt: complaint.classificationAssignedAt?.toISOString() ?? null,
    previousAssignedBy: complaint.classificationAssignedBy,
    previousTaxonomyFingerprint: complaint.classificationTaxonomyFingerprint,
    previousAssignmentRunId: complaint.classificationAssignmentRunId,
    targetClassificationId: decision.targetClassificationId,
    targetCategoryId: decision.targetCategoryId,
    confidence: decision.confidence,
    reasonCode: decision.reasonCode,
    evidenceSummary: decision.evidenceSummary,
    complaintStateHash: computeComplaintStateHash(complaint),
    taxonomyFingerprint,
  };
}

type AuditGroupAnalysis = {
  counts: Record<AuditResultCode, number>;
  corrections: AuditManifestCorrection[];
  privateReview: unknown[];
  groups: AuditGroupSummary[];
  mismatchCount: number;
  misclassifiedSourceDetailGroups: number;
};

function analyzeComplaintGroup(input: {
  complaints: AuditComplaint[];
  index: IndexedTaxonomy;
  taxonomyFingerprint: string;
  analysis: AuditGroupAnalysis;
}): void {
  const representative = input.complaints[0]!;
  const homogeneousDecision = exactSourceDecision(representative, input.index);
  let representativeDecision: EvidenceDecision | null = homogeneousDecision;
  let groupCorrectionCount = 0;

  for (const complaint of input.complaints) {
    if (!isCurrentReferenceValid(complaint, input.index)) input.analysis.mismatchCount += 1;
    const decision = homogeneousDecision ?? evaluateHistoricalClassification(complaint, input.index);
    representativeDecision ??= decision;
    input.analysis.counts[decision.result] += 1;
    if (decision.result === AUDIT_RESULTS.CORRECT_HIGH_CONFIDENCE) {
      groupCorrectionCount += 1;
      input.analysis.corrections.push(
        buildCorrection(complaint, decision, input.taxonomyFingerprint)
      );
    } else if (decision.result === AUDIT_RESULTS.REVIEW) {
      input.analysis.privateReview.push(buildPrivateReviewEntry(complaint, decision));
    }
  }

  if (groupCorrectionCount > 0) input.analysis.misclassifiedSourceDetailGroups += 1;
  const groupDecision = representativeDecision!;
  input.analysis.groups.push({
    sourceDetailHash: sha256(normalizeEvidenceText(representative.sourceDetail)),
    currentClassificationId: representative.classificationId,
    currentCategoryId: representative.categoryId,
    count: input.complaints.length,
    result:
      groupCorrectionCount > 0
        ? AUDIT_RESULTS.CORRECT_HIGH_CONFIDENCE
        : groupDecision.result,
    targetClassificationId: groupDecision.targetClassificationId,
    targetCategoryId: groupDecision.targetCategoryId,
    confidence: groupDecision.confidence,
    reasonCode: groupDecision.reasonCode,
  });
}

function analyzeAuditGroups(
  grouped: ReadonlyMap<string, AuditComplaint[]>,
  index: IndexedTaxonomy,
  taxonomyFingerprint: string
): AuditGroupAnalysis {
  const analysis: AuditGroupAnalysis = {
    counts: emptyResultCounts(),
    corrections: [],
    privateReview: [],
    groups: [],
    mismatchCount: 0,
    misclassifiedSourceDetailGroups: 0,
  };
  for (const complaints of grouped.values()) {
    analyzeComplaintGroup({ complaints, index, taxonomyFingerprint, analysis });
  }
  analysis.corrections.sort((left, right) => compareCodeUnits(left.complaintId, right.complaintId));
  return analysis;
}

function findUnusedClassificationCandidates(
  complaints: readonly AuditComplaint[],
  index: IndexedTaxonomy
): UnusedClassificationCandidate[] {
  const usedClassificationIds = new Set(
    complaints
      .map((complaint) => complaint.classificationId)
      .filter((value): value is string => value !== null)
  );
  return index.active
    .filter((classification) => !usedClassificationIds.has(classification.id))
    .map((classification) => ({
      classificationId: classification.id,
      classificationName: classification.nameAr,
      categoryId: classification.category.id,
      categoryName: classification.category.nameAr,
    }))
    .sort((left, right) => compareCodeUnits(left.classificationName, right.classificationName));
}

function buildManifestPayload(input: {
  generatedAt: string;
  databaseFingerprint: DatabaseFingerprint;
  taxonomyFingerprint: string;
  totalComplaints: number;
  groupCount: number;
  analysis: AuditGroupAnalysis;
  unusedClassificationCandidates: UnusedClassificationCandidate[];
  distribution: DistributionEntry[];
  categoryDistribution: CategoryDistributionEntry[];
}): ManifestUnsigned {
  return {
    schemaVersion: CLASSIFICATION_AUDIT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    databaseFingerprint: input.databaseFingerprint,
    taxonomyFingerprint: input.taxonomyFingerprint,
    totalComplaints: input.totalComplaints,
    keepCount: input.analysis.counts.KEEP,
    correctionCount: input.analysis.counts.CORRECT_HIGH_CONFIDENCE,
    reviewCount: input.analysis.counts.REVIEW,
    ambiguousCount: input.analysis.counts.AMBIGUOUS,
    insufficientEvidenceCount: input.analysis.counts.INSUFFICIENT_EVIDENCE,
    invalidReferenceCount: input.analysis.counts.INVALID_TAXONOMY_REFERENCE,
    uniqueSourceDetailGroups: input.groupCount,
    misclassifiedSourceDetailGroups: input.analysis.misclassifiedSourceDetailGroups,
    categoryClassificationMismatchCountBefore: input.analysis.mismatchCount,
    unusedClassificationCandidates: input.unusedClassificationCandidates,
    distribution: input.distribution,
    categoryDistribution: input.categoryDistribution,
    groups: input.analysis.groups,
    corrections: input.analysis.corrections,
  };
}

export async function previewHistoricalClassificationAudit(
  db: AuditDb,
  input: {
    manifestPath: string;
    privateReviewPath?: string;
    overwrite?: boolean;
  }
): Promise<AuditDryRunResult> {
  const started = Date.now();
  const absoluteManifest = resolve(input.manifestPath);
  if (existsSync(absoluteManifest) && input.overwrite !== true) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.MANIFEST_INVALID,
      "ملف manifest موجود مسبقًا؛ استخدم --overwrite=true"
    );
  }

  const [taxonomy, totalComplaintCount, complaints] = await Promise.all([
    loadAuditTaxonomy(db),
    db.complaint.count(),
    loadActiveComplaints(db),
  ]);
  const taxonomyFingerprint = computeTaxonomyFingerprint(taxonomy);
  const databaseFingerprint = computeDatabaseFingerprint({
    totalComplaintCount,
    complaints,
    taxonomyFingerprint,
  });
  const index = buildAuditTaxonomyIndex(taxonomy);
  const grouped = groupComplaintsBySource(complaints);
  const analysis = analyzeAuditGroups(grouped, index, taxonomyFingerprint);
  const distribution = buildDistribution(complaints, analysis.corrections, taxonomy);
  const categoryDistribution = buildCategoryDistribution(
    complaints,
    analysis.corrections,
    taxonomy
  );
  const unusedClassificationCandidates = findUnusedClassificationCandidates(complaints, index);
  const unsigned = buildManifestPayload({
    generatedAt: new Date().toISOString(),
    databaseFingerprint,
    taxonomyFingerprint,
    totalComplaints: complaints.length,
    groupCount: grouped.size,
    analysis,
    unusedClassificationCandidates,
    distribution,
    categoryDistribution,
  });
  const manifestHash = computeAuditManifestHash(unsigned);
  const confirmationToken = buildConfirmationToken(manifestHash, analysis.corrections.length);
  const manifest: HistoricalClassificationAuditManifest = {
    ...unsigned,
    manifestHash,
    confirmationToken,
  };
  assertManifestPrivateDataAbsent(manifest);
  await writeJsonAtomically(absoluteManifest, manifest);
  if (input.privateReviewPath) {
    await writeJsonAtomically(input.privateReviewPath, {
      generatedAt: manifest.generatedAt,
      manifestHash,
      reviewCount: analysis.privateReview.length,
      reviews: analysis.privateReview,
    });
  }

  const memory = process.memoryUsage();
  return {
    mode: "dry-run",
    manifestPath: absoluteManifest,
    manifestHash,
    confirmationToken,
    taxonomyFingerprint,
    totalComplaints: complaints.length,
    counts: analysis.counts,
    uniqueSourceDetailGroups: grouped.size,
    misclassifiedSourceDetailGroups: analysis.misclassifiedSourceDetailGroups,
    categoryClassificationMismatchCountBefore: analysis.mismatchCount,
    unusedClassificationCandidates,
    distribution,
    categoryDistribution,
    performance: {
      complaintsScanned: complaints.length,
      groupsAnalyzed: grouped.size,
      candidateCorrections: analysis.corrections.length,
      databaseQueries: 3,
      elapsedMs: Date.now() - started,
      heapUsedBytes: memory.heapUsed,
      rssBytes: memory.rss,
    },
  };
}

export function readAndValidateAuditManifest(path: string): HistoricalClassificationAuditManifest {
  if (!path) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.MANIFEST_REQUIRED,
      "مسار manifest مطلوب"
    );
  }
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.MANIFEST_NOT_FOUND,
      "ملف manifest غير موجود"
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.MANIFEST_INVALID,
      "تعذر قراءة manifest"
    );
  }
  const manifest = parsed as HistoricalClassificationAuditManifest;
  if (
    manifest?.schemaVersion !== CLASSIFICATION_AUDIT_SCHEMA_VERSION ||
    !Array.isArray(manifest.corrections) ||
    !Array.isArray(manifest.groups) ||
    !manifest.manifestHash ||
    !manifest.confirmationToken
  ) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.MANIFEST_INVALID,
      "صيغة manifest غير صالحة"
    );
  }
  const ids = new Set<string>();
  for (const correction of manifest.corrections) {
    if (
      !correction.complaintId ||
      ids.has(correction.complaintId) ||
      correction.confidence < 0.9 ||
      !correction.targetClassificationId ||
      !correction.targetCategoryId ||
      correction.taxonomyFingerprint !== manifest.taxonomyFingerprint
    ) {
      throw new HistoricalClassificationAuditError(
        AUDIT_ERROR_CODES.MANIFEST_INVALID,
        "صف تصحيح مكرر أو ناقص أو دون حد الثقة"
      );
    }
    ids.add(correction.complaintId);
  }
  const { manifestHash, confirmationToken, ...unsigned } = manifest;
  const recomputed = computeAuditManifestHash(unsigned);
  if (recomputed !== manifestHash) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.MANIFEST_HASH_MISMATCH,
      "بصمة manifest لا تطابق المحتوى"
    );
  }
  if (confirmationToken !== buildConfirmationToken(manifestHash, manifest.corrections.length)) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.MANIFEST_INVALID,
      "رمز تأكيد manifest غير متسق"
    );
  }
  assertManifestPrivateDataAbsent(manifest);
  return manifest;
}

async function assertManifestStillCurrent(
  db: AuditDb,
  manifest: HistoricalClassificationAuditManifest
): Promise<{
  taxonomy: AuditTaxonomyClassification[];
  complaints: AuditComplaint[];
  totalComplaintCount: number;
}> {
  const [taxonomy, complaints, totalComplaintCount] = await Promise.all([
    loadAuditTaxonomy(db),
    loadActiveComplaints(db),
    db.complaint.count(),
  ]);
  const taxonomyFingerprint = computeTaxonomyFingerprint(taxonomy);
  if (taxonomyFingerprint !== manifest.taxonomyFingerprint) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.TAXONOMY_CHANGED,
      "تغيرت Taxonomy منذ dry-run"
    );
  }
  const current = computeDatabaseFingerprint({ totalComplaintCount, complaints, taxonomyFingerprint });
  if (stableStringify(current) !== stableStringify(manifest.databaseFingerprint)) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.DATABASE_CHANGED,
      "تغيرت بيانات الشكاوى منذ dry-run؛ أنشئ manifest جديدًا"
    );
  }
  const activeById = new Map(
    buildAuditTaxonomyIndex(taxonomy).active.map((classification) => [classification.id, classification])
  );
  for (const correction of manifest.corrections) {
    const target = activeById.get(correction.targetClassificationId);
    if (target?.category.id !== correction.targetCategoryId) {
      throw new HistoricalClassificationAuditError(
        AUDIT_ERROR_CODES.TAXONOMY_CHANGED,
        "target لم يعد فعالًا أو تغيرت فئته"
      );
    }
  }
  return { taxonomy, complaints, totalComplaintCount };
}

function sanitizeFailure(error: unknown): string {
  if (error instanceof HistoricalClassificationAuditError) return error.message;
  if (error instanceof Error) return error.message.replaceAll(/\s+/g, " ").slice(0, 200);
  return "UNEXPECTED_ERROR";
}

async function createAuditRunAndItems(input: {
  db: AuditDb;
  manifest: HistoricalClassificationAuditManifest;
  actor: string;
  batchSize: number;
  backupName: string;
}): Promise<string> {
  const run = await input.db.classificationAuditRun.create({
    data: {
      operation: "APPLY",
      status: "APPLYING",
      taxonomyFingerprint: input.manifest.taxonomyFingerprint,
      databaseFingerprint: sha256(stableStringify(input.manifest.databaseFingerprint)),
      manifestHash: input.manifest.manifestHash,
      totalComplaintCountBefore: input.manifest.databaseFingerprint.totalComplaintCount,
      activeComplaintCountBefore: input.manifest.databaseFingerprint.activeComplaintCount,
      plannedCount: input.manifest.corrections.length,
      reviewCount: input.manifest.reviewCount,
      ambiguousCount: input.manifest.ambiguousCount,
      insufficientEvidenceCount: input.manifest.insufficientEvidenceCount,
      invalidReferenceCount: input.manifest.invalidReferenceCount,
      batchSize: input.batchSize,
      actor: input.actor,
      backupName: input.backupName,
    },
  });
  for (const batch of chunks(input.manifest.corrections, input.batchSize)) {
    await input.db.classificationAuditItem.createMany({
      data: batch.map((correction) => ({
        runId: run.id,
        complaintId: correction.complaintId,
        expectedVersion: correction.expectedVersion,
        previousClassificationId: correction.previousClassificationId,
        previousCategoryId: correction.previousCategoryId,
        targetClassificationId: correction.targetClassificationId,
        targetCategoryId: correction.targetCategoryId,
        previousAssignmentSource: correction.previousAssignmentSource,
        previousAssignedAt: correction.previousAssignedAt
          ? new Date(correction.previousAssignedAt)
          : null,
        previousAssignedBy: correction.previousAssignedBy,
        previousTaxonomyFingerprint: correction.previousTaxonomyFingerprint,
        previousAssignmentRunId: correction.previousAssignmentRunId,
        complaintStateHash: correction.complaintStateHash,
        reasonCode: correction.reasonCode,
        confidence: correction.confidence,
        result: "PLANNED",
      })),
    });
  }
  await writeAuditLog(input.db, {
    action: "CLASSIFICATION_HISTORICAL_AUDIT_STARTED",
    entityType: "ClassificationAuditRun",
    entityId: run.id,
    actor: input.actor,
    metadata: {
      auditRunId: run.id,
      manifestHash: input.manifest.manifestHash,
      plannedCount: input.manifest.corrections.length,
      backupName: input.backupName,
    },
  });
  return run.id;
}

type ApplyItem = Awaited<ReturnType<AuditDb["classificationAuditItem"]["findMany"]>>[number];

export function evaluateAuditApplyState(input: {
  complaint: AuditComplaint | null | undefined;
  item: Pick<
    ApplyItem,
    | "expectedVersion"
    | "previousClassificationId"
    | "previousCategoryId"
    | "complaintStateHash"
    | "targetClassificationId"
    | "targetCategoryId"
  >;
  activeTargetCategoryId: string | null;
}): { action: "APPLY" } | { action: "SKIP"; reason: string } {
  const { complaint, item } = input;
  if (!complaint || complaint.isDeleted) {
    return { action: "SKIP", reason: AUDIT_SKIP_REASONS.DELETED_AFTER_PREVIEW };
  }
  if (complaint.version !== item.expectedVersion) {
    return { action: "SKIP", reason: AUDIT_SKIP_REASONS.VERSION_CHANGED };
  }
  if (
    complaint.classificationId !== item.previousClassificationId ||
    complaint.categoryId !== item.previousCategoryId ||
    computeComplaintStateHash(complaint) !== item.complaintStateHash
  ) {
    return { action: "SKIP", reason: AUDIT_SKIP_REASONS.TARGET_CHANGED };
  }
  if (input.activeTargetCategoryId === null) {
    return { action: "SKIP", reason: AUDIT_SKIP_REASONS.TARGET_INACTIVE };
  }
  if (input.activeTargetCategoryId !== item.targetCategoryId) {
    return { action: "SKIP", reason: AUDIT_SKIP_REASONS.CATEGORY_CLASSIFICATION_MISMATCH };
  }
  return { action: "APPLY" };
}

async function processApplyBatch(input: {
  db: AuditDb;
  runId: string;
  actor: string;
  taxonomyFingerprint: string;
  items: ApplyItem[];
}): Promise<{ applied: number; skipped: number }> {
  return input.db.$transaction(async (tx) => {
    const complaints = await tx.complaint.findMany({
      where: { id: { in: input.items.map((item) => item.complaintId) } },
      select: complaintAuditSelect,
    });
    const byId = new Map(complaints.map((complaint) => [complaint.id, complaint]));
    const targetIds = [...new Set(input.items.map((item) => item.targetClassificationId))];
    const targets = await tx.classification.findMany({
      where: {
        id: { in: targetIds },
        isActive: true,
        isDeleted: false,
        category: { isActive: true, isDeleted: false },
      },
      select: { id: true, categoryId: true },
    });
    const targetById = new Map(targets.map((target) => [target.id, target]));
    let applied = 0;
    let skipped = 0;

    for (const item of input.items) {
      const complaint = byId.get(item.complaintId);
      const decision = evaluateAuditApplyState({
        complaint,
        item,
        activeTargetCategoryId: targetById.get(item.targetClassificationId)?.categoryId ?? null,
      });
      if (decision.action === "SKIP") {
        await tx.classificationAuditItem.update({
          where: { id: item.id },
          data: { result: "SKIPPED", skipReason: decision.reason },
        });
        skipped += 1;
        continue;
      }

      const assignment = buildClassificationAssignmentMetadata({
        source: CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_CORRECTION,
        assignedBy: input.actor,
        taxonomyFingerprint: input.taxonomyFingerprint,
        assignmentRunId: null,
      });
      const updated = await tx.complaint.updateMany({
        where: {
          id: item.complaintId,
          version: item.expectedVersion,
          isDeleted: false,
          classificationId: item.previousClassificationId,
          categoryId: item.previousCategoryId,
        },
        data: {
          classificationId: item.targetClassificationId,
          categoryId: item.targetCategoryId,
          ...assignment,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        await tx.classificationAuditItem.update({
          where: { id: item.id },
          data: { result: "SKIPPED", skipReason: AUDIT_SKIP_REASONS.VERSION_CHANGED },
        });
        skipped += 1;
        continue;
      }
      const appliedAt = new Date();
      await tx.classificationAuditItem.update({
        where: { id: item.id },
        data: {
          result: "APPLIED",
          appliedVersion: item.expectedVersion + 1,
          appliedAt,
          skipReason: null,
        },
      });
      await writeAuditLog(tx, {
        action: "COMPLAINT_CLASSIFICATION_HISTORICALLY_CORRECTED",
        entityType: "Complaint",
        entityId: item.complaintId,
        actor: input.actor,
        metadata: {
          previousClassificationId: item.previousClassificationId,
          previousCategoryId: item.previousCategoryId,
          targetClassificationId: item.targetClassificationId,
          targetCategoryId: item.targetCategoryId,
          reasonCode: item.reasonCode,
          confidence: item.confidence,
          auditRunId: input.runId,
        },
      });
      applied += 1;
    }
    return { applied, skipped };
  });
}

function validateApplyConfirmation(
  manifest: HistoricalClassificationAuditManifest,
  confirmation: string | undefined
): void {
  if (!confirmation) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.CONFIRMATION_REQUIRED,
      "رمز التأكيد مطلوب"
    );
  }
  if (confirmation !== manifest.confirmationToken) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.CONFIRMATION_INVALID,
      "رمز التأكيد غير صحيح"
    );
  }
}

async function createRequiredBackup(
  createAndVerifyBackup: (() => Promise<BackupReceipt>) | undefined
): Promise<BackupReceipt> {
  if (!createAndVerifyBackup) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.BACKUP_REQUIRED,
      "apply يتطلب إنشاء backup والتحقق منه قبل الكتابة"
    );
  }
  try {
    const backup = await createAndVerifyBackup();
    if (!backup.verified || !backup.backupName) throw new Error("invalid backup receipt");
    return backup;
  } catch (error) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.BACKUP_FAILED,
      "فشل إنشاء backup أو التحقق منه",
      { cause: sanitizeFailure(error) }
    );
  }
}

type ApplyBatchProcessingResult = {
  pendingCount: number;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  failureMessage: string | null;
};

async function processPendingApplyBatches(input: {
  db: AuditDb;
  runId: string;
  actor: string;
  taxonomyFingerprint: string;
  batchSize: number;
}): Promise<ApplyBatchProcessingResult> {
  const pending = await input.db.classificationAuditItem.findMany({
    where: { runId: input.runId, result: "PLANNED" },
    orderBy: { complaintId: "asc" },
  });
  let appliedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let failureMessage: string | null = null;
  for (const batch of chunks(pending, input.batchSize)) {
    try {
      const result = await processApplyBatch({
        db: input.db,
        runId: input.runId,
        actor: input.actor,
        taxonomyFingerprint: input.taxonomyFingerprint,
        items: batch,
      });
      appliedCount += result.applied;
      skippedCount += result.skipped;
    } catch (error) {
      failureMessage = sanitizeFailure(error);
      failedCount += batch.length;
      await input.db.classificationAuditItem.updateMany({
        where: { id: { in: batch.map((item) => item.id) }, result: "PLANNED" },
        data: { result: "FAILED", skipReason: "BATCH_TRANSACTION_FAILED" },
      });
      break;
    }
  }
  return { pendingCount: pending.length, appliedCount, skippedCount, failedCount, failureMessage };
}

export function resolveApplyStatus(input: {
  failedCount: number;
  appliedCount: number;
  skippedCount: number;
}): "APPLIED" | "PARTIALLY_APPLIED" | "FAILED" {
  if (input.failedCount > 0 && input.appliedCount === 0) return "FAILED";
  if (input.failedCount > 0 || input.skippedCount > 0) return "PARTIALLY_APPLIED";
  return "APPLIED";
}

function resolveApplyAuditAction(
  status: "APPLIED" | "PARTIALLY_APPLIED" | "FAILED"
): "CLASSIFICATION_HISTORICAL_AUDIT_APPLIED" | "CLASSIFICATION_HISTORICAL_AUDIT_PARTIALLY_APPLIED" {
  if (status === "APPLIED") return "CLASSIFICATION_HISTORICAL_AUDIT_APPLIED";
  return "CLASSIFICATION_HISTORICAL_AUDIT_PARTIALLY_APPLIED";
}

function resolveApplyFailureCode(failedCount: number): string | null {
  if (failedCount > 0) return "BATCH_TRANSACTION_FAILED";
  return null;
}

export async function applyHistoricalClassificationAudit(
  db: AuditDb,
  input: {
    manifestPath: string;
    confirm?: string;
    actor?: string;
    batchSize?: number;
    createAndVerifyBackup?: () => Promise<BackupReceipt>;
  }
): Promise<AuditApplyResult> {
  const started = Date.now();
  const manifest = readAndValidateAuditManifest(input.manifestPath);
  validateApplyConfirmation(manifest, input.confirm);
  const batchSize = validateAuditBatchSize(input.batchSize ?? DEFAULT_AUDIT_BATCH_SIZE);
  const actor = input.actor ?? CLASSIFICATION_AUDIT_ACTOR;
  await assertManifestStillCurrent(db, manifest);
  const alreadyApplied = await db.classificationAuditRun.findFirst({
    where: { operation: "APPLY", status: "APPLIED", manifestHash: manifest.manifestHash },
    select: { id: true },
  });
  if (alreadyApplied) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.ALREADY_APPLIED,
      "تم تطبيق هذا manifest مسبقًا",
      { runId: alreadyApplied.id }
    );
  }
  const backup = await createRequiredBackup(input.createAndVerifyBackup);

  const runId = await createAuditRunAndItems({ db, manifest, actor, batchSize, backupName: backup.backupName });
  const batchResult = await processPendingApplyBatches({
    db,
    runId,
    actor,
    taxonomyFingerprint: manifest.taxonomyFingerprint,
    batchSize,
  });
  const { appliedCount, skippedCount, failedCount, failureMessage } = batchResult;
  const [totalAfter, activeAfter] = await Promise.all([
    db.complaint.count(),
    db.complaint.count({ where: { isDeleted: false } }),
  ]);
  const status = resolveApplyStatus({ failedCount, appliedCount, skippedCount });
  await db.classificationAuditRun.update({
    where: { id: runId },
    data: {
      status,
      appliedCount,
      skippedCount,
      failedCount,
      totalComplaintCountAfter: totalAfter,
      activeComplaintCountAfter: activeAfter,
      completedAt: new Date(),
      failureCode: resolveApplyFailureCode(failedCount),
      failureMessage,
    },
  });
  await writeAuditLog(db, {
    action: resolveApplyAuditAction(status),
    entityType: "ClassificationAuditRun",
    entityId: runId,
    actor,
    metadata: { auditRunId: runId, appliedCount, skippedCount, failedCount, backupName: backup.backupName },
  });
  const elapsedMs = Date.now() - started;
  const memory = process.memoryUsage();
  return {
    mode: "apply",
    runId,
    status,
    plannedCount: manifest.corrections.length,
    appliedCount,
    skippedCount,
    failedCount,
    backupName: backup.backupName,
    rollbackToken: buildAuditRollbackToken({ runId, manifestHash: manifest.manifestHash, appliedCount }),
    elapsedMs,
    performance: {
      databaseQueries: 11 + Math.ceil(batchResult.pendingCount / batchSize) * 2 + appliedCount * 3,
      elapsedMs,
      heapUsedBytes: memory.heapUsed,
      rssBytes: memory.rss,
    },
  };
}

async function loadRunOrThrow(db: AuditDb, runId: string) {
  const run = await db.classificationAuditRun.findUnique({ where: { id: runId } });
  if (!run) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.RUN_NOT_FOUND,
      "تشغيل audit غير موجود"
    );
  }
  return run;
}

async function verifyKnownRegressions(db: AuditDb): Promise<AuditVerifyResult["knownRegressions"]> {
  const results: AuditVerifyResult["knownRegressions"] = [];
  for (const fixture of KNOWN_REGRESSIONS) {
    const target = await db.classification.findFirst({
      where: {
        nameAr: fixture.classificationName,
        isActive: true,
        isDeleted: false,
        category: {
          nameAr: fixture.categoryName,
          isActive: true,
          isDeleted: false,
        },
      },
      select: { id: true, categoryId: true },
    });
    const matchedCount = await db.complaint.count({
      where: { isDeleted: false, sourceDetail: fixture.sourceDetail },
    });
    const correctCount = target
      ? await db.complaint.count({
          where: {
            isDeleted: false,
            sourceDetail: fixture.sourceDetail,
            classificationId: target.id,
            categoryId: target.categoryId,
          },
        })
      : 0;
    results.push({
      sourceDetailLabel: fixture.sourceDetail,
      expectedClassification: fixture.classificationName,
      expectedCategory: fixture.categoryName,
      matchedCount,
      correctCount,
      ok: matchedCount === 0 || (Boolean(target) && matchedCount === correctCount),
    });
  }
  return results;
}

export async function verifyHistoricalClassificationAudit(
  db: AuditDb,
  input: { runId: string }
): Promise<AuditVerifyResult> {
  const run = await loadRunOrThrow(db, input.runId);
  const originalRun = run.operation === "ROLLBACK" && run.rollbackOfRunId
    ? await loadRunOrThrow(db, run.rollbackOfRunId)
    : run;
  const items = await db.classificationAuditItem.findMany({
    where: { runId: originalRun.id },
    orderBy: { complaintId: "asc" },
  });
  const appliedItems = items.filter((item) => item.result === "APPLIED");
  const appliedComplaints = appliedItems.length === 0
    ? []
    : await db.complaint.findMany({
        where: { id: { in: appliedItems.map((item) => item.complaintId) } },
        select: {
          id: true,
          classificationId: true,
          categoryId: true,
          version: true,
          isDeleted: true,
        },
      });
  const appliedById = new Map(appliedComplaints.map((complaint) => [complaint.id, complaint]));
  const appliedManifestOk = appliedItems.every((item) => {
    const complaint = appliedById.get(item.complaintId);
    return Boolean(
      complaint &&
      !complaint.isDeleted &&
      complaint.classificationId === item.targetClassificationId &&
      complaint.categoryId === item.targetCategoryId &&
      complaint.version === item.appliedVersion
    );
  });
  const [totalAfter, activeAfter, taxonomy, complaints] = await Promise.all([
    db.complaint.count(),
    db.complaint.count({ where: { isDeleted: false } }),
    loadAuditTaxonomy(db),
    loadActiveComplaints(db),
  ]);
  // Prisma cannot express field-to-field equality; compute referential consistency locally.
  const taxonomyById = new Map(taxonomy.map((classification) => [classification.id, classification]));
  const appliedItemByComplaint = new Map(
    appliedItems.map((item) => [item.complaintId, item])
  );
  const beforeComplaints = complaints.map((complaint) => {
    const item = appliedItemByComplaint.get(complaint.id);
    return item
      ? {
          ...complaint,
          classificationId: item.previousClassificationId,
          categoryId: item.previousCategoryId,
        }
      : complaint;
  });
  const mismatchCountBefore = beforeComplaints.filter((complaint) => {
    if (!complaint.classificationId) return false;
    return taxonomyById.get(complaint.classificationId)?.category.id !== complaint.categoryId;
  }).length;
  const mismatchCount = complaints.filter((complaint) => {
    if (!complaint.classificationId) return false;
    return taxonomyById.get(complaint.classificationId)?.category.id !== complaint.categoryId;
  }).length;
  const activeIds = new Set(
    buildAuditTaxonomyIndex(taxonomy).active.map((classification) => classification.id)
  );
  const targetValidityOk = appliedItems.every((item) => activeIds.has(item.targetClassificationId));
  const observedCorrections = appliedItems.map((item) => ({
    complaintId: item.complaintId,
    targetClassificationId: item.targetClassificationId,
    targetCategoryId: item.targetCategoryId,
  }));
  const knownRegressions = await verifyKnownRegressions(db);
  const countIntegrity =
    totalAfter === originalRun.totalComplaintCountBefore &&
    activeAfter === originalRun.activeComplaintCountBefore;
  const invariants = [
    { code: "APPLIED_MANIFEST", ok: appliedManifestOk, detail: `${appliedItems.length} applied items checked` },
    { code: "COUNT_INTEGRITY", ok: countIntegrity, detail: `${originalRun.totalComplaintCountBefore}->${totalAfter}` },
    { code: "NO_DUPLICATES_OR_DELETIONS", ok: countIntegrity, detail: `active ${originalRun.activeComplaintCountBefore}->${activeAfter}` },
    { code: "CATEGORY_CLASSIFICATION_CONSISTENCY", ok: mismatchCount === 0, detail: `${mismatchCount} mismatches` },
    { code: "TARGET_TAXONOMY_VALID", ok: targetValidityOk, detail: `${appliedItems.length} targets checked` },
    { code: "KNOWN_REGRESSIONS", ok: knownRegressions.every((entry) => entry.ok), detail: `${knownRegressions.length} fixtures checked` },
  ];
  const ok = invariants.every((invariant) => invariant.ok);
  await db.classificationAuditRun.update({
    where: { id: run.id },
    data: {
      status: ok ? run.status : "VERIFY_FAILED",
      failureCode: ok ? run.failureCode : AUDIT_ERROR_CODES.VERIFY_FAILED,
      totalComplaintCountAfter: totalAfter,
      activeComplaintCountAfter: activeAfter,
    },
  });
  return {
    mode: "verify",
    runId: run.id,
    ok,
    invariants,
    totalComplaintsBefore: originalRun.totalComplaintCountBefore,
    totalComplaintsAfter: totalAfter,
    activeComplaintsBefore: originalRun.activeComplaintCountBefore,
    activeComplaintsAfter: activeAfter,
    appliedCount: appliedItems.length,
    distribution: buildDistribution(beforeComplaints, observedCorrections, taxonomy),
    categoryDistribution: buildCategoryDistribution(beforeComplaints, observedCorrections, taxonomy),
    categoryClassificationMismatchCountBefore: mismatchCountBefore,
    categoryClassificationMismatchCountAfter: mismatchCount,
    knownRegressions,
  };
}

export async function rollbackHistoricalClassificationAudit(
  db: AuditDb,
  input: {
    runId: string;
    confirm?: string;
    actor?: string;
    batchSize?: number;
  }
): Promise<AuditRollbackResult> {
  const original = await loadRunOrThrow(db, input.runId);
  if (original.operation !== "APPLY") {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.RUN_NOT_FOUND,
      "rollback يتطلب run من نوع APPLY"
    );
  }
  const expectedToken = buildAuditRollbackToken({
    runId: original.id,
    manifestHash: original.manifestHash,
    appliedCount: original.appliedCount,
  });
  if (!input.confirm) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.CONFIRMATION_REQUIRED,
      "رمز rollback مطلوب"
    );
  }
  if (input.confirm !== expectedToken) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.CONFIRMATION_INVALID,
      "رمز rollback غير صحيح"
    );
  }
  const actor = input.actor ?? CLASSIFICATION_AUDIT_ACTOR;
  const batchSize = validateAuditBatchSize(input.batchSize ?? DEFAULT_AUDIT_BATCH_SIZE);
  const rollbackRun = await db.classificationAuditRun.create({
    data: {
      operation: "ROLLBACK",
      status: "ROLLING_BACK",
      taxonomyFingerprint: original.taxonomyFingerprint,
      databaseFingerprint: original.databaseFingerprint,
      manifestHash: original.manifestHash,
      totalComplaintCountBefore: await db.complaint.count(),
      activeComplaintCountBefore: await db.complaint.count({ where: { isDeleted: false } }),
      plannedCount: original.appliedCount,
      batchSize,
      actor,
      rollbackOfRunId: original.id,
    },
  });
  const items = await db.classificationAuditItem.findMany({
    where: { runId: original.id, result: "APPLIED" },
    orderBy: { complaintId: "asc" },
  });
  let rolledBackCount = 0;
  let skippedCount = 0;
  for (const batch of chunks(items, batchSize)) {
    await db.$transaction(async (tx) => {
      const complaints = await tx.complaint.findMany({
        where: { id: { in: batch.map((item) => item.complaintId) } },
        select: complaintAuditSelect,
      });
      const byId = new Map(complaints.map((complaint) => [complaint.id, complaint]));
      for (const item of batch) {
        const complaint = byId.get(item.complaintId);
        let skipReason: string | null = null;
        if (!complaint || complaint.isDeleted) {
          skipReason = AUDIT_SKIP_REASONS.ROLLBACK_SKIPPED_DELETED;
        } else if (complaint.version !== item.appliedVersion) {
          skipReason = AUDIT_SKIP_REASONS.ROLLBACK_SKIPPED_VERSION_CHANGED;
        } else if (
          complaint.classificationId !== item.targetClassificationId ||
          complaint.categoryId !== item.targetCategoryId ||
          complaint.classificationAssignmentSource !==
            CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_CORRECTION
        ) {
          skipReason = AUDIT_SKIP_REASONS.ROLLBACK_SKIPPED_TARGET_CHANGED;
        }
        if (skipReason) {
          await tx.classificationAuditItem.update({
            where: { id: item.id },
            data: { skipReason },
          });
          skippedCount += 1;
          continue;
        }
        const updated = await tx.complaint.updateMany({
          where: {
            id: item.complaintId,
            version: item.appliedVersion ?? -1,
            isDeleted: false,
            classificationId: item.targetClassificationId,
            categoryId: item.targetCategoryId,
            classificationAssignmentSource:
              CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_CORRECTION,
          },
          data: {
            classificationId: item.previousClassificationId,
            categoryId: item.previousCategoryId,
            classificationAssignmentSource: item.previousAssignmentSource,
            classificationAssignedAt: item.previousAssignedAt,
            classificationAssignedBy: item.previousAssignedBy,
            classificationTaxonomyFingerprint: item.previousTaxonomyFingerprint,
            classificationAssignmentRunId: item.previousAssignmentRunId,
            version: { increment: 1 },
            updatedAt: new Date(),
          },
        });
        if (updated.count !== 1) {
          await tx.classificationAuditItem.update({
            where: { id: item.id },
            data: { skipReason: AUDIT_SKIP_REASONS.ROLLBACK_SKIPPED_VERSION_CHANGED },
          });
          skippedCount += 1;
          continue;
        }
        await tx.classificationAuditItem.update({
          where: { id: item.id },
          data: { result: "ROLLED_BACK", rolledBackAt: new Date(), skipReason: null },
        });
        await writeAuditLog(tx, {
          action: "COMPLAINT_CLASSIFICATION_HISTORICAL_CORRECTION_ROLLED_BACK",
          entityType: "Complaint",
          entityId: item.complaintId,
          actor,
          metadata: {
            previousClassificationId: item.targetClassificationId,
            previousCategoryId: item.targetCategoryId,
            targetClassificationId: item.previousClassificationId,
            targetCategoryId: item.previousCategoryId,
            reasonCode: item.reasonCode,
            confidence: item.confidence,
            auditRunId: rollbackRun.id,
          },
        });
        rolledBackCount += 1;
      }
    });
  }
  const [totalAfter, activeAfter] = await Promise.all([
    db.complaint.count(),
    db.complaint.count({ where: { isDeleted: false } }),
  ]);
  const status = skippedCount > 0 ? "PARTIALLY_ROLLED_BACK" : "ROLLED_BACK";
  await db.classificationAuditRun.update({
    where: { id: rollbackRun.id },
    data: {
      status,
      appliedCount: rolledBackCount,
      skippedCount,
      totalComplaintCountAfter: totalAfter,
      activeComplaintCountAfter: activeAfter,
      completedAt: new Date(),
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
