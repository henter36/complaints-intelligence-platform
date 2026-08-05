// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import {
  buildComplaintSlaTiming,
  resolveComplaintEffectiveClosedAt,
  type ComplaintSlaSnapshot,
} from "./complaint-sla-timing";

const DAY_MS = 24 * 60 * 60 * 1000;

function snapshot(
  overrides: Partial<ComplaintSlaSnapshot> & Pick<ComplaintSlaSnapshot, "status">
): ComplaintSlaSnapshot {
  const created = overrides.complaintDate ?? overrides.receivedAt ?? new Date("2026-07-01T00:00:00.000Z");
  return {
    status: overrides.status,
    complaintDate: overrides.complaintDate ?? created,
    receivedAt: overrides.receivedAt ?? created,
    closedAt: overrides.closedAt ?? null,
    lastUpdatedAt: overrides.lastUpdatedAt ?? null,
  };
}

describe("resolveComplaintEffectiveClosedAt", () => {
  it("returns null for open complaints even when lastUpdatedAt is set", () => {
    expect(
      resolveComplaintEffectiveClosedAt(
        snapshot({
          status: ComplaintStatus.OPEN,
          closedAt: null,
          lastUpdatedAt: new Date("2026-07-10T00:00:00.000Z"),
        })
      )
    ).toBeNull();
  });

  it("prefers closedAt when both closedAt and lastUpdatedAt are present", () => {
    const closedAt = new Date("2026-07-05T00:00:00.000Z");
    expect(
      resolveComplaintEffectiveClosedAt(
        snapshot({
          status: ComplaintStatus.CLOSED,
          closedAt,
          lastUpdatedAt: new Date("2026-07-20T00:00:00.000Z"),
        })
      )
    ).toEqual(closedAt);
  });

  it("falls back to lastUpdatedAt when closedAt is missing", () => {
    const lastUpdatedAt = new Date("2026-07-08T00:00:00.000Z");
    expect(
      resolveComplaintEffectiveClosedAt(
        snapshot({
          status: ComplaintStatus.CLOSED,
          closedAt: null,
          lastUpdatedAt,
        })
      )
    ).toEqual(lastUpdatedAt);
  });

  it("falls back to lastUpdatedAt when closedAt precedes creation", () => {
    const created = new Date("2026-07-10T00:00:00.000Z");
    const lastUpdatedAt = new Date("2026-07-12T00:00:00.000Z");
    expect(
      resolveComplaintEffectiveClosedAt(
        snapshot({
          status: ComplaintStatus.RESOLVED,
          complaintDate: created,
          receivedAt: created,
          closedAt: new Date("2026-07-01T00:00:00.000Z"),
          lastUpdatedAt,
        })
      )
    ).toEqual(lastUpdatedAt);
  });

  it("returns null when neither closedAt nor lastUpdatedAt is trusted", () => {
    const created = new Date("2026-07-10T00:00:00.000Z");
    expect(
      resolveComplaintEffectiveClosedAt(
        snapshot({
          status: ComplaintStatus.CLOSED,
          complaintDate: created,
          receivedAt: created,
          closedAt: new Date("2026-07-01T00:00:00.000Z"),
          lastUpdatedAt: new Date("2026-07-05T00:00:00.000Z"),
        })
      )
    ).toBeNull();
  });
});

describe("buildComplaintSlaTiming with lastUpdatedAt", () => {
  it("treats exact 7-day closure as compliant (not late)", () => {
    const created = new Date("2026-07-01T00:00:00.000Z");
    const timing = buildComplaintSlaTiming(
      snapshot({
        status: ComplaintStatus.CLOSED,
        complaintDate: created,
        receivedAt: created,
        closedAt: new Date(created.getTime() + 7 * DAY_MS),
      }),
      new Date("2026-07-20T00:00:00.000Z")
    );
    expect(timing.state).toBe("CLOSED_WITHIN_SLA");
    expect(timing.wasClosedWithinSla).toBe(true);
    expect(timing.wasClosedLate).toBe(false);
  });

  it("does not count closedWithoutTrustedDate when lastUpdatedAt is valid", () => {
    const created = new Date("2026-07-01T00:00:00.000Z");
    const timing = buildComplaintSlaTiming(
      snapshot({
        status: ComplaintStatus.CLOSED,
        complaintDate: created,
        receivedAt: created,
        closedAt: null,
        lastUpdatedAt: new Date("2026-07-04T00:00:00.000Z"),
      }),
      new Date("2026-07-20T00:00:00.000Z")
    );
    expect(timing.closedWithoutTrustedDate).toBe(false);
    expect(timing.wasClosedWithinSla).toBe(true);
  });

  it("uses lastUpdatedAt for resolution duration", () => {
    const created = new Date("2026-07-01T00:00:00.000Z");
    const timing = buildComplaintSlaTiming(
      snapshot({
        status: ComplaintStatus.CLOSED,
        complaintDate: created,
        receivedAt: created,
        closedAt: null,
        lastUpdatedAt: new Date("2026-07-04T00:00:00.000Z"),
      })
    );
    expect(timing.resolutionDurationDays).toBe(3);
  });
});
