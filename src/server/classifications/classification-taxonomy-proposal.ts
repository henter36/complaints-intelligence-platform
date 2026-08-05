import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareCodeUnits } from "./canonical-string-order";
import { assertClassificationNameDiffersFromCategory } from "./classification-management-service";

export const RESTRUCTURE_SCHEMA_VERSION = 1;
export const PROPOSAL_STATUS_REQUIRED = "PROPOSED_NOT_APPLIED";

export const RESTRUCTURE_ERROR_CODES = {
  PROPOSAL_REQUIRED: "PROPOSAL_REQUIRED",
  PROPOSAL_NOT_FOUND: "PROPOSAL_NOT_FOUND",
  PROPOSAL_INVALID: "PROPOSAL_INVALID",
  PROPOSAL_SCHEMA_UNSUPPORTED: "PROPOSAL_SCHEMA_UNSUPPORTED",
  PROPOSAL_STATUS_INVALID: "PROPOSAL_STATUS_INVALID",
  MAPPING_REQUIRED: "MAPPING_REQUIRED",
  MAPPING_NOT_FOUND: "MAPPING_NOT_FOUND",
  MAPPING_MISMATCH: "MAPPING_MISMATCH",
  DUPLICATE_SOURCE_DETAIL: "DUPLICATE_SOURCE_DETAIL",
  DUPLICATE_CLASSIFICATION_KEY: "DUPLICATE_CLASSIFICATION_KEY",
  NAMING_CONFLICT: "NAMING_CONFLICT",
  MANIFEST_REQUIRED: "MANIFEST_REQUIRED",
  MANIFEST_NOT_FOUND: "MANIFEST_NOT_FOUND",
  MANIFEST_INVALID: "MANIFEST_INVALID",
  MANIFEST_HASH_MISMATCH: "MANIFEST_HASH_MISMATCH",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  CONFIRMATION_INVALID: "CONFIRMATION_INVALID",
  CLASSIFICATION_TAXONOMY_CHANGED_AFTER_PREVIEW:
    "CLASSIFICATION_TAXONOMY_CHANGED_AFTER_PREVIEW",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  MANIFEST_EXISTS: "MANIFEST_EXISTS",
  CATEGORY_CLASSIFICATION_MISMATCH: "CATEGORY_CLASSIFICATION_MISMATCH",
  OTHER_REVIEW_MISSING: "OTHER_REVIEW_MISSING",
} as const;

export class TaxonomyRestructureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TaxonomyRestructureError";
  }
}

export type ProposedClassification = {
  category: string;
  classification: string;
  classificationKey: string;
  sourceDetails: string[];
  mappedCount: number;
  legacyPreservedCount: number;
  projectedCount: number;
  notes?: string;
};

export type ProposedCategory = {
  category: string;
  projectedCount: number;
  classifications: ProposedClassification[];
};

export type SourceDetailMapping = {
  sourceDetail: string;
  count: number;
  currentPath: string;
  proposedCategory: string;
  proposedClassification: string;
  proposedPath: string;
  categoryKey: string;
  classificationKey: string;
  decision: string;
  reason: string;
};

export type EntityMigration = {
  entityType: string;
  currentId: string;
  currentName: string;
  action: string;
  target: string;
  details: string;
};

export type ClassificationTaxonomyProposal = {
  schemaVersion: number;
  generatedAt: string;
  status: string;
  principles: string[];
  sourceSummary: Record<string, unknown>;
  validation: {
    sourceDetailValuesMapped: number;
    mappedComplaintCount: number;
    legacyPreservedCount: number;
    projectedTotalComplaintCount: number;
    currentAmbiguousCount: number;
    currentUnmatchedCount: number;
    dataQualityHoldingCount: number;
  };
  proposedTaxonomy: ProposedCategory[];
  sourceDetailMappings: SourceDetailMapping[];
  currentEntityMigration: EntityMigration[];
};

function serializeStableEntry(key: string, value: unknown): string {
  return JSON.stringify(key) + ":" + stableStringify(value);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(compareCodeUnits);
  return "{" + keys.map((key) => serializeStableEntry(key, obj[key])).join(",") + "}";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function fileContentHash(path: string): string {
  return sha256(readFileSync(path, "utf8"));
}

function findDuplicates(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCsv(content: string): Record<string, string>[] {
  const text = content.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function resolveProposalInputPaths(
  proposalPath: string,
  mappingCsvPath: string
): { proposalAbs: string; mappingAbs: string } {
  if (!proposalPath) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.PROPOSAL_REQUIRED, "مسار المقترح مطلوب");
  }
  if (!mappingCsvPath) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.MAPPING_REQUIRED, "مسار CSV مطلوب");
  }
  const proposalAbs = resolve(proposalPath);
  const mappingAbs = resolve(mappingCsvPath);
  if (!existsSync(proposalAbs)) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.PROPOSAL_NOT_FOUND, "ملف المقترح غير موجود");
  }
  if (!existsSync(mappingAbs)) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.MAPPING_NOT_FOUND, "ملف CSV غير موجود");
  }
  return { proposalAbs, mappingAbs };
}

function readProposalJson(proposalAbs: string): ClassificationTaxonomyProposal {
  try {
    return JSON.parse(readFileSync(proposalAbs, "utf8")) as ClassificationTaxonomyProposal;
  } catch {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID, "تعذر قراءة JSON");
  }
}

function validateProposalSchema(proposal: ClassificationTaxonomyProposal): void {
  if (proposal.schemaVersion !== RESTRUCTURE_SCHEMA_VERSION) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.PROPOSAL_SCHEMA_UNSUPPORTED,
      `إصدار schema غير مدعوم: ${String(proposal.schemaVersion)}`
    );
  }
}

function validateProposalStatus(proposal: ClassificationTaxonomyProposal): void {
  if (proposal.status !== PROPOSAL_STATUS_REQUIRED) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.PROPOSAL_STATUS_INVALID,
      `حالة المقترح غير صالحة: ${proposal.status}`
    );
  }
}

function validateProposalTotals(proposal: ClassificationTaxonomyProposal): void {
  const val = proposal.validation;
  if (val.mappedComplaintCount + val.legacyPreservedCount !== val.projectedTotalComplaintCount) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID, "مجاميع التحقق غير متسقة");
  }
}

function collectProposedClassificationKeys(
  proposal: ClassificationTaxonomyProposal
): string[] {
  return proposal.proposedTaxonomy.flatMap((c) =>
    c.classifications.map((x) => x.classificationKey)
  );
}

function assertUniqueClassificationKeys(keys: string[]): void {
  const dupKeys = findDuplicates(keys);
  if (dupKeys.length === 0) return;
  throw new TaxonomyRestructureError(
    RESTRUCTURE_ERROR_CODES.DUPLICATE_CLASSIFICATION_KEY,
    "مفاتيح تصنيف مكررة",
    { keys: dupKeys }
  );
}

function assertUniqueSourceDetails(proposal: ClassificationTaxonomyProposal): void {
  const sourceDetails = proposal.sourceDetailMappings.map((m) => m.sourceDetail);
  const dupDetails = findDuplicates(sourceDetails);
  if (dupDetails.length === 0) return;
  throw new TaxonomyRestructureError(
    RESTRUCTURE_ERROR_CODES.DUPLICATE_SOURCE_DETAIL,
    "قيم sourceDetail مكررة",
    { values: dupDetails }
  );
}

function validateClassificationNames(proposal: ClassificationTaxonomyProposal): void {
  for (const cat of proposal.proposedTaxonomy) {
    for (const cls of cat.classifications) {
      try {
        assertClassificationNameDiffersFromCategory(cls.category, cls.classification);
      } catch {
        throw new TaxonomyRestructureError(
          RESTRUCTURE_ERROR_CODES.NAMING_CONFLICT,
          `اسم فرعي يطابق الرئيسي: ${cls.category} / ${cls.classification}`
        );
      }
    }
  }
}

function validateOtherReviewMapping(proposal: ClassificationTaxonomyProposal): void {
  const other = proposal.sourceDetailMappings.find((m) => m.sourceDetail.trim() === "أخرى");
  const isValid =
    other?.classificationKey === "OTHER_REVIEW" &&
    other?.proposedPath === "بيانات غير محددة / أخرى تحتاج مراجعة";
  if (isValid) return;
  throw new TaxonomyRestructureError(
    RESTRUCTURE_ERROR_CODES.OTHER_REVIEW_MISSING,
    "قيمة «أخرى» يجب أن ترتبط بحاوية جودة البيانات"
  );
}

function loadMappingCsv(mappingAbs: string): Record<string, string>[] {
  return parseCsv(readFileSync(mappingAbs, "utf8"));
}

function validateMappingRowCount(
  csvRows: Record<string, string>[],
  proposal: ClassificationTaxonomyProposal
): void {
  if (csvRows.length === proposal.sourceDetailMappings.length) return;
  throw new TaxonomyRestructureError(
    RESTRUCTURE_ERROR_CODES.MAPPING_MISMATCH,
    `عدد صفوف CSV (${csvRows.length}) لا يطابق JSON (${proposal.sourceDetailMappings.length})`
  );
}

function validateMappingRow(
  row: Record<string, string>,
  byDetail: Map<string, SourceDetailMapping>
): void {
  const sd = (row["قيمة تفصيل"] ?? "").trim();
  const mapped = byDetail.get(sd);
  if (!mapped) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.MAPPING_MISMATCH,
      "قيمة CSV غير موجودة في JSON",
      { sourceDetailHash: sha256(sd).slice(0, 12) }
    );
  }
  if (Number(row["عدد الشكاوى"]) !== mapped.count) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.MAPPING_MISMATCH,
      `عدد غير متطابق لـ ${mapped.classificationKey}`
    );
  }
  if ((row["المسار المقترح"] ?? "").trim() !== mapped.proposedPath) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.MAPPING_MISMATCH,
      `مسار غير متطابق لـ ${mapped.classificationKey}`
    );
  }
  if ((row["مفتاح التصنيف"] ?? "").trim() !== mapped.classificationKey) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.MAPPING_MISMATCH, "مفتاح غير متطابق");
  }
}

function validateMappingRows(
  csvRows: Record<string, string>[],
  proposal: ClassificationTaxonomyProposal
): void {
  const byDetail = new Map(proposal.sourceDetailMappings.map((m) => [m.sourceDetail, m]));
  for (const row of csvRows) {
    validateMappingRow(row, byDetail);
  }
}

function buildProposalValidationResult(
  proposal: ClassificationTaxonomyProposal,
  proposalAbs: string,
  mappingAbs: string
): { proposal: ClassificationTaxonomyProposal; proposalHash: string; mappingHash: string } {
  return {
    proposal,
    proposalHash: fileContentHash(proposalAbs),
    mappingHash: fileContentHash(mappingAbs),
  };
}

export function loadAndValidateProposal(
  proposalPath: string,
  mappingCsvPath: string
): { proposal: ClassificationTaxonomyProposal; proposalHash: string; mappingHash: string } {
  const { proposalAbs, mappingAbs } = resolveProposalInputPaths(proposalPath, mappingCsvPath);
  const proposal = readProposalJson(proposalAbs);
  validateProposalSchema(proposal);
  validateProposalStatus(proposal);
  validateProposalTotals(proposal);
  assertUniqueClassificationKeys(collectProposedClassificationKeys(proposal));
  assertUniqueSourceDetails(proposal);
  validateClassificationNames(proposal);
  validateOtherReviewMapping(proposal);
  const csvRows = loadMappingCsv(mappingAbs);
  validateMappingRowCount(csvRows, proposal);
  validateMappingRows(csvRows, proposal);
  return buildProposalValidationResult(proposal, proposalAbs, mappingAbs);
}

export function buildConfirmationToken(manifestHash: string, changeCount: number): string {
  return `RESTRUCTURE-${changeCount}-${manifestHash.slice(0, 10).toUpperCase()}`;
}

export function buildRollbackToken(runId: string, manifestHash: string, appliedOps: number): string {
  const hash = sha256(`${runId}|${manifestHash}|${appliedOps}`).toUpperCase();
  return `ROLLBACK-${appliedOps}-${hash.slice(0, 10)}`;
}

export function parseDualId(currentId: string): { categoryId?: string; classificationId?: string } {
  if (currentId.includes(" / ")) {
    const [a, b] = currentId.split(" / ").map((s) => s.trim());
    return { categoryId: a, classificationId: b };
  }
  return {};
}

export function splitTargetPath(target: string): { categoryName: string; classificationName: string } {
  if (target.includes(" / ")) {
    const [cat, cls] = target.split(" / ").map((s) => s.trim());
    return { categoryName: cat!, classificationName: cls! };
  }
  return { categoryName: "", classificationName: target.trim() };
}
