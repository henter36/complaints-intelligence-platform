import type { ClassificationBriefRow, RegionReferenceRow } from "@/lib/reports/report-contract";
import { UNCLASSIFIED_CLASSIFICATION_KEY } from "@/lib/reports/classification-keys";

/** Visible PDF-style sums for regional reference rows. */
export function sumRegionReferenceRows(rows: ReadonlyArray<RegionReferenceRow>): {
  current: number;
  previous: number;
  difference: number;
  open: number;
  late: number;
} {
  return rows.reduce(
    (acc, row) => {
      acc.current += row.currentCount;
      acc.previous += row.previousCount;
      acc.difference += row.difference;
      acc.open += row.openCount ?? 0;
      acc.late += row.currentlyLate ?? 0;
      return acc;
    },
    { current: 0, previous: 0, difference: 0, open: 0, late: 0 }
  );
}

export function sumClassificationRows(rows: ReadonlyArray<ClassificationBriefRow>): number {
  return rows.reduce((sum, row) => sum + row.currentCount, 0);
}

export function reconcileClassificationOpenLate(
  rows: ReadonlyArray<ClassificationBriefRow>,
  openLate: Record<string, { openAtEnd: number; lateAtEnd: number }>
): Array<ClassificationBriefRow & { openAtEnd: number; lateAtEnd: number }> {
  return rows.map((row) => {
    const ol = openLate[row.classificationId] ?? { openAtEnd: 0, lateAtEnd: 0 };
    return { ...row, ...ol };
  });
}

export function sumClassificationOpenLate(
  rows: ReadonlyArray<{ openAtEnd: number; lateAtEnd: number }>
): { openAtEnd: number; lateAtEnd: number } {
  return rows.reduce(
    (acc, row) => {
      acc.openAtEnd += row.openAtEnd;
      acc.lateAtEnd += row.lateAtEnd;
      return acc;
    },
    { openAtEnd: 0, lateAtEnd: 0 }
  );
}

export function assertUnclassifiedUsesSentinel(
  rows: ReadonlyArray<{ classificationId: string; classificationName: string }>
): void {
  const unclassified = rows.filter(
    (row) => row.classificationName === "غير مصنف" || row.classificationId === UNCLASSIFIED_CLASSIFICATION_KEY
  );
  for (const row of unclassified) {
    if (row.classificationId !== UNCLASSIFIED_CLASSIFICATION_KEY) {
      throw new Error(`Unclassified row must use sentinel id, got ${row.classificationId}`);
    }
  }
}
