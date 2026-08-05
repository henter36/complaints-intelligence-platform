import { describe, expect, it } from "vitest";
import {
  UNCLASSIFIED_CLASSIFICATION_KEY,
  UNCLASSIFIED_CLASSIFICATION_LABEL,
} from "@/lib/reports/classification-keys";
import {
  assertUnclassifiedUsesSentinel,
  reconcileClassificationOpenLate,
  sumClassificationOpenLate,
  sumRegionReferenceRows,
} from "./report-reconciliation";

describe("report-reconciliation helpers", () => {
  it("sums regional reference rows", () => {
    const sums = sumRegionReferenceRows([
      {
        regionName: "منطقة الرياض",
        currentCount: 10,
        previousCount: 4,
        difference: 6,
        changeRate: 150,
        complianceRate: null,
        averageResolutionDays: null,
        openCount: 2,
        closedCount: 8,
        currentlyLate: 1,
        direction: "ارتفاع",
      },
      {
        regionName: "جدة",
        currentCount: 5,
        previousCount: 5,
        difference: 0,
        changeRate: 0,
        complianceRate: null,
        averageResolutionDays: null,
        openCount: 1,
        closedCount: 4,
        currentlyLate: 0,
        direction: "دون تغير",
      },
    ]);
    expect(sums).toEqual({
      current: 15,
      previous: 9,
      difference: 6,
      open: 3,
      late: 1,
    });
  });

  it("requires unclassified rows to use the shared sentinel id", () => {
    expect(() =>
      assertUnclassifiedUsesSentinel([
        {
          classificationId: UNCLASSIFIED_CLASSIFICATION_KEY,
          classificationName: UNCLASSIFIED_CLASSIFICATION_LABEL,
        },
      ])
    ).not.toThrow();

    expect(() =>
      assertUnclassifiedUsesSentinel([
        {
          classificationId: UNCLASSIFIED_CLASSIFICATION_LABEL,
          classificationName: UNCLASSIFIED_CLASSIFICATION_LABEL,
        },
      ])
    ).toThrow(/sentinel id/);
  });

  it("joins open/late by sentinel rather than Arabic display name", () => {
    const enriched = reconcileClassificationOpenLate(
      [
        {
          classificationId: UNCLASSIFIED_CLASSIFICATION_KEY,
          classificationName: UNCLASSIFIED_CLASSIFICATION_LABEL,
          currentCount: 8,
          previousCount: 0,
          difference: 8,
          changeRate: null,
          shareOfTotal: 80,
        },
      ],
      { [UNCLASSIFIED_CLASSIFICATION_KEY]: { openAtEnd: 5, lateAtEnd: 5 } }
    );
    expect(sumClassificationOpenLate(enriched)).toEqual({ openAtEnd: 5, lateAtEnd: 5 });
  });
});
