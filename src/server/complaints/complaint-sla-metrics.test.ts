import { ComplaintStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { buildComplaintSlaMetrics } from "./complaint-sla-metrics";
import type { ComplaintSlaSnapshot } from "./complaint-sla-timing";

const DAY_MS = 24 * 60 * 60 * 1000;
const measuredAt = new Date("2026-07-31T00:00:00.000Z");

function complaint(
  createdAt: Date,
  overrides: Partial<ComplaintSlaSnapshot> = {}
): ComplaintSlaSnapshot {
  return {
    status: ComplaintStatus.OPEN,
    complaintDate: createdAt,
    receivedAt: createdAt,
    closedAt: null,
    lastUpdatedAt: null,
    ...overrides,
  };
}

describe("buildComplaintSlaMetrics", () => {
  it("computes compliance from measurable seven-day states only", () => {
    const oldCreatedAt = new Date("2026-07-01T00:00:00.000Z");
    const result = buildComplaintSlaMetrics([
      complaint(new Date(measuredAt.getTime() - 6 * DAY_MS)),
      complaint(new Date(measuredAt.getTime() - 8 * DAY_MS)),
      complaint(oldCreatedAt, {
        status: ComplaintStatus.CLOSED,
        closedAt: new Date(oldCreatedAt.getTime() + 7 * DAY_MS),
      }),
      complaint(oldCreatedAt, {
        status: ComplaintStatus.CLOSED,
        closedAt: new Date(oldCreatedAt.getTime() + 8 * DAY_MS),
      }),
      complaint(oldCreatedAt, {
        status: ComplaintStatus.CLOSED,
        closedAt: null,
      }),
    ], measuredAt);

    expect(result).toMatchObject({
      eligibleCount: 4,
      compliantCount: 2,
      nonCompliantCount: 2,
      openWithinSlaCount: 1,
      openLateCount: 1,
      closedWithinSlaCount: 1,
      closedLateCount: 1,
      closedWithoutTrustedDateCount: 1,
      complianceRate: 50,
      averageResolutionDays: 7.5,
      medianResolutionDays: 7.5,
      averageResolutionEligibleCount: 2,
    });
  });

  it("returns null averages instead of zero when no trusted closure dates exist", () => {
    const createdAt = new Date("2026-07-01T00:00:00.000Z");
    const result = buildComplaintSlaMetrics([
      complaint(createdAt, {
        status: ComplaintStatus.CLOSED,
        closedAt: null,
      }),
    ], measuredAt);

    expect(result.averageResolutionDays).toBeNull();
    expect(result.medianResolutionDays).toBeNull();
    expect(result.averageResolutionEligibleCount).toBe(0);
    expect(result.complianceRate).toBeNull();
    expect(result.closedWithoutTrustedDateCount).toBe(1);
  });

  it("distinguishes a real zero-day average from unavailable data", () => {
    const createdAt = new Date("2026-07-20T10:00:00.000Z");
    const result = buildComplaintSlaMetrics([
      complaint(createdAt, {
        status: ComplaintStatus.CLOSED,
        closedAt: createdAt,
      }),
    ], measuredAt);

    expect(result.averageResolutionDays).toBe(0);
    expect(result.averageResolutionEligibleCount).toBe(1);
    expect(result.complianceRate).toBe(100);
  });

  it("keeps the eligibility accounting invariant", () => {
    const result = buildComplaintSlaMetrics([
      complaint(new Date(measuredAt.getTime() - 1 * DAY_MS)),
      complaint(new Date(measuredAt.getTime() - 10 * DAY_MS)),
    ], measuredAt);

    expect(result.eligibleCount).toBe(
      result.compliantCount + result.nonCompliantCount
    );
  });
});
