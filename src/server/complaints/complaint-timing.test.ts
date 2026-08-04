import { ComplaintStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  buildComplaintSlaTiming,
  COMPLAINT_SLA_DAYS,
  type ComplaintSlaSnapshot,
} from "./complaint-sla-timing";

const DAY_MS = 24 * 60 * 60 * 1000;
const createdAt = new Date("2026-07-01T06:00:00.000Z");

function complaint(
  overrides: Partial<ComplaintSlaSnapshot> = {}
): ComplaintSlaSnapshot {
  return {
    status: ComplaintStatus.OPEN,
    complaintDate: createdAt,
    receivedAt: createdAt,
    closedAt: null,
    ...overrides,
  };
}

describe("buildComplaintSlaTiming — fixed seven-day SLA", () => {
  it("keeps an open complaint within SLA through the exact seven-day boundary", () => {
    const deadline = new Date(createdAt.getTime() + COMPLAINT_SLA_DAYS * DAY_MS);
    const result = buildComplaintSlaTiming(complaint(), deadline);

    expect(result.state).toBe("OPEN_WITHIN_SLA");
    expect(result.isCurrentlyLate).toBe(false);
    expect(result.isEligible).toBe(true);
    expect(result.isCompliant).toBe(true);
  });

  it("marks an open complaint late only after the seven-day boundary", () => {
    const afterDeadline = new Date(createdAt.getTime() + COMPLAINT_SLA_DAYS * DAY_MS + 1);
    const result = buildComplaintSlaTiming(complaint(), afterDeadline);

    expect(result.state).toBe("OPEN_LATE");
    expect(result.isCurrentlyLate).toBe(true);
    expect(result.isCompliant).toBe(false);
  });

  it.each([
    ["CLOSED_WITHIN_SLA", COMPLAINT_SLA_DAYS * DAY_MS],
    ["CLOSED_LATE", COMPLAINT_SLA_DAYS * DAY_MS + 1],
  ] as const)("classifies a trusted closure as %s", (expected, duration) => {
    const result = buildComplaintSlaTiming(
      complaint({
        status: ComplaintStatus.CLOSED,
        closedAt: new Date(createdAt.getTime() + duration),
      }),
      new Date(createdAt.getTime() + 20 * DAY_MS)
    );

    expect(result.state).toBe(expected);
  });

  it("does not accept dueDate as an SLA input", () => {
    const legacyComplaint = {
      ...complaint(),
      dueDate: new Date(createdAt.getTime() + 60 * DAY_MS),
    };
    const result = buildComplaintSlaTiming(
      legacyComplaint,
      new Date(createdAt.getTime() + 8 * DAY_MS)
    );

    expect(result.state).toBe("OPEN_LATE");
  });

  it("separates closed complaints without a trusted closure date", () => {
    const result = buildComplaintSlaTiming(
      complaint({ status: ComplaintStatus.CLOSED, closedAt: null }),
      new Date(createdAt.getTime() + 20 * DAY_MS)
    );

    expect(result.state).toBe("CLOSED_WITHOUT_TRUSTED_DATE");
    expect(result.closedWithoutTrustedDate).toBe(true);
    expect(result.isEligible).toBe(false);
    expect(result.resolutionDurationDays).toBeNull();
  });

  it("keeps exact duration for averages", () => {
    const result = buildComplaintSlaTiming(
      complaint({
        status: ComplaintStatus.CLOSED,
        closedAt: new Date(createdAt.getTime() + 12 * 60 * 60 * 1000),
      })
    );

    expect(result.resolutionDurationDays).toBe(0.5);
  });

  it("does not trust a closure date before the complaint creation date", () => {
    const result = buildComplaintSlaTiming(
      complaint({
        status: ComplaintStatus.CLOSED,
        closedAt: new Date(createdAt.getTime() - 1),
      })
    );

    expect(result.state).toBe("CLOSED_WITHOUT_TRUSTED_DATE");
    expect(result.resolutionDurationDays).toBeNull();
  });

  it("falls back to receivedAt when complaintDate is missing", () => {
    const receivedAt = new Date("2026-07-10T00:00:00.000Z");
    const result = buildComplaintSlaTiming(
      complaint({ complaintDate: null, receivedAt }),
      new Date(receivedAt.getTime() + 6 * DAY_MS)
    );

    expect(result.deadline?.toISOString()).toBe(
      new Date(receivedAt.getTime() + 7 * DAY_MS).toISOString()
    );
    expect(result.state).toBe("OPEN_WITHIN_SLA");
  });
});
