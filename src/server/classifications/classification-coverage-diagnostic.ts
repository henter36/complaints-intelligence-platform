import {
  resolveSourceDetailClassification,
  type SourceDetailClassificationCandidate,
} from "./source-detail-classification-resolver";

export type ClassificationDiagnosticComplaint = {
  id: string;
  classificationId: string | null;
  sourceDetail: string | null;
};

export type ClassificationDiagnosticImportRow = {
  complaintId: string;
  normalizedData: unknown;
  validationWarnings: unknown;
  createdAt: Date;
};

export type ClassificationCoverageDiagnostic = {
  periodTotal: number;
  classifiedById: number;
  unclassifiedTotal: number;
  classificationTextOnly: number;
  withSourceDetail: number;
  resolvedMatched: number;
  resolvedMatchedButUnlinked: number;
  resolvedAmbiguous: number;
  unresolved: number;
  missingClassificationInput: number;
  classificationCoverageRate: number;
};

export type CurrentResolverCoverageDiagnostic = {
  evaluatedUnclassifiedWithSourceDetail: number;
  currentMatchedComplaints: number;
  currentAmbiguousComplaints: number;
  currentUnmatchedComplaints: number;
  distinctSourceDetailValues: number;
  currentMatchedDistinctValues: number;
  currentAmbiguousDistinctValues: number;
  currentUnmatchedDistinctValues: number;
  projectedClassifiedById: number;
  projectedClassificationCoverageRate: number;
};

const MATCHED_CODE = "CLASSIFICATION_RESOLVED_FROM_SOURCE_DETAIL";
const AMBIGUOUS_CODE = "SOURCE_DETAIL_CLASSIFICATION_AMBIGUOUS";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function warningCodes(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.flatMap((item) => {
      const code = nonEmptyString(asRecord(item)?.code);
      return code ? [code] : [];
    })
  );
}

function latestRowsByComplaint(
  rows: readonly ClassificationDiagnosticImportRow[]
): Map<string, ClassificationDiagnosticImportRow> {
  const latest = new Map<string, ClassificationDiagnosticImportRow>();
  for (const row of rows) {
    const current = latest.get(row.complaintId);
    if (!current || row.createdAt > current.createdAt) {
      latest.set(row.complaintId, row);
    }
  }
  return latest;
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0
    ? Math.round((numerator / denominator) * 1000) / 10
    : 0;
}

export function analyzeClassificationCoverage(
  complaints: readonly ClassificationDiagnosticComplaint[],
  rows: readonly ClassificationDiagnosticImportRow[]
): ClassificationCoverageDiagnostic {
  const latestRows = latestRowsByComplaint(rows);
  const result: ClassificationCoverageDiagnostic = {
    periodTotal: complaints.length,
    classifiedById: 0,
    unclassifiedTotal: 0,
    classificationTextOnly: 0,
    withSourceDetail: 0,
    resolvedMatched: 0,
    resolvedMatchedButUnlinked: 0,
    resolvedAmbiguous: 0,
    unresolved: 0,
    missingClassificationInput: 0,
    classificationCoverageRate: 0,
  };

  for (const complaint of complaints) {
    const row = latestRows.get(complaint.id);
    const normalized = asRecord(row?.normalizedData);
    const classificationText = nonEmptyString(normalized?.classification);
    const sourceDetail = nonEmptyString(complaint.sourceDetail)
      ?? nonEmptyString(normalized?.sourceDetail);
    const codes = warningCodes(row?.validationWarnings);
    const matched = codes.has(MATCHED_CODE);
    const ambiguous = codes.has(AMBIGUOUS_CODE);

    if (sourceDetail) result.withSourceDetail += 1;
    if (matched) result.resolvedMatched += 1;
    if (ambiguous) result.resolvedAmbiguous += 1;

    if (complaint.classificationId) {
      result.classifiedById += 1;
      continue;
    }

    result.unclassifiedTotal += 1;
    if (classificationText) result.classificationTextOnly += 1;

    if (matched) {
      result.resolvedMatchedButUnlinked += 1;
    } else if (!ambiguous && (classificationText || sourceDetail)) {
      result.unresolved += 1;
    } else if (!ambiguous) {
      result.missingClassificationInput += 1;
    }
  }

  result.classificationCoverageRate = percentage(
    result.classifiedById,
    result.periodTotal
  );

  return result;
}

export function analyzeCurrentResolverCoverage(
  complaints: readonly ClassificationDiagnosticComplaint[],
  classifications: readonly SourceDetailClassificationCandidate[]
): CurrentResolverCoverageDiagnostic {
  const distinctStatuses = new Map<string, "MATCHED" | "AMBIGUOUS" | "UNMATCHED">();
  let evaluated = 0;
  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;

  for (const complaint of complaints) {
    if (complaint.classificationId) continue;
    const sourceDetail = nonEmptyString(complaint.sourceDetail);
    if (!sourceDetail) continue;

    const resolution = resolveSourceDetailClassification({
      sourceDetail,
      classifications,
    });
    evaluated += 1;

    if (resolution.status === "MATCHED") {
      matched += 1;
      distinctStatuses.set(resolution.normalizedValue, "MATCHED");
    } else if (resolution.status === "AMBIGUOUS") {
      ambiguous += 1;
      distinctStatuses.set(resolution.normalizedValue, "AMBIGUOUS");
    } else if (resolution.status === "UNMATCHED") {
      unmatched += 1;
      distinctStatuses.set(resolution.normalizedValue, "UNMATCHED");
    }
  }

  const existingClassified = complaints.filter(
    (complaint) => Boolean(complaint.classificationId)
  ).length;
  const distinctValues = [...distinctStatuses.values()];
  const projectedClassifiedById = existingClassified + matched;

  return {
    evaluatedUnclassifiedWithSourceDetail: evaluated,
    currentMatchedComplaints: matched,
    currentAmbiguousComplaints: ambiguous,
    currentUnmatchedComplaints: unmatched,
    distinctSourceDetailValues: distinctStatuses.size,
    currentMatchedDistinctValues: distinctValues.filter((status) => status === "MATCHED").length,
    currentAmbiguousDistinctValues: distinctValues.filter((status) => status === "AMBIGUOUS").length,
    currentUnmatchedDistinctValues: distinctValues.filter((status) => status === "UNMATCHED").length,
    projectedClassifiedById,
    projectedClassificationCoverageRate: percentage(
      projectedClassifiedById,
      complaints.length
    ),
  };
}
