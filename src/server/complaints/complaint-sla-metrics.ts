import { roundToTenth } from "@/lib/complaint-metrics";
import {
  buildComplaintSlaTiming,
  type ComplaintSlaSnapshot,
} from "./complaint-sla-timing";

export type ComplaintSlaMetrics = {
  eligibleCount: number;
  compliantCount: number;
  nonCompliantCount: number;
  openWithinSlaCount: number;
  openLateCount: number;
  closedWithinSlaCount: number;
  closedLateCount: number;
  closedWithoutTrustedDateCount: number;
  complianceRate: number | null;
  averageResolutionDays: number | null;
  medianResolutionDays: number | null;
  averageResolutionEligibleCount: number;
};

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator > 0
    ? roundToTenth((numerator / denominator) * 100)
    : null;
}

export function buildComplaintSlaMetrics(
  complaints: readonly ComplaintSlaSnapshot[],
  measuredAt = new Date()
): ComplaintSlaMetrics {
  const timing = complaints.map((complaint) =>
    buildComplaintSlaTiming(complaint, measuredAt)
  );
  const resolutionDurations = timing.flatMap((item) =>
    item.resolutionDurationDays === null ? [] : [item.resolutionDurationDays]
  );
  const eligibleCount = timing.filter((item) => item.isEligible).length;
  const compliantCount = timing.filter((item) => item.isCompliant).length;
  const nonCompliantCount = eligibleCount - compliantCount;

  return {
    eligibleCount,
    compliantCount,
    nonCompliantCount,
    openWithinSlaCount: timing.filter((item) => item.state === "OPEN_WITHIN_SLA").length,
    openLateCount: timing.filter((item) => item.state === "OPEN_LATE").length,
    closedWithinSlaCount: timing.filter((item) => item.state === "CLOSED_WITHIN_SLA").length,
    closedLateCount: timing.filter((item) => item.state === "CLOSED_LATE").length,
    closedWithoutTrustedDateCount: timing.filter(
      (item) => item.state === "CLOSED_WITHOUT_TRUSTED_DATE"
    ).length,
    complianceRate: percentage(compliantCount, eligibleCount),
    averageResolutionDays: average(resolutionDurations) === null
      ? null
      : roundToTenth(average(resolutionDurations)!),
    medianResolutionDays: median(resolutionDurations) === null
      ? null
      : roundToTenth(median(resolutionDurations)!),
    averageResolutionEligibleCount: resolutionDurations.length,
  };
}
