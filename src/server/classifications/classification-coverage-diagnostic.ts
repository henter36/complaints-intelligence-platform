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

  result.classificationCoverageRate = result.periodTotal > 0
    ? Math.round((result.classifiedById / result.periodTotal) * 1000) / 10
    : 0;

  return result;
}
