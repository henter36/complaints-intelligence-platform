import { describe, expect, it } from "vitest";
import { ComplaintStatus, FacilityStatus } from "@prisma/client";

import { normalizeFacilityName } from "@/server/facilities/facility-name";
import { createFacilityOperationalRegistry } from "@/server/facilities/facility-operational-scope-service";
import type { PeriodRange } from "./report-comparison";
import {
  computeExecutiveReportSnapshot,
  type SnapshotCandidate,
} from "./report-period-snapshot-service";

const registry = createFacilityOperationalRegistry([
  {
    id: "active-zero",
    name: "Facility A ACTIVE",
    normalizedName: normalizeFacilityName("Facility A ACTIVE")!,
    region: "منطقة الرياض",
    status: FacilityStatus.ACTIVE,
    closedAt: null,
  },
  {
    id: "active-backlog",
    name: "Facility B ACTIVE",
    normalizedName: normalizeFacilityName("Facility B ACTIVE")!,
    region: "منطقة الرياض",
    status: FacilityStatus.ACTIVE,
    closedAt: null,
  },
  {
    id: "closed",
    name: "Facility C CLOSED",
    normalizedName: normalizeFacilityName("Facility C CLOSED")!,
    region: "منطقة الرياض",
    status: FacilityStatus.CLOSED,
    closedAt: new Date("2026-08-01T00:00:00.000Z"),
  },
  {
    id: "closed-zero",
    name: "Facility D CLOSED",
    normalizedName: normalizeFacilityName("Facility D CLOSED")!,
    region: "منطقة الرياض",
    status: FacilityStatus.CLOSED,
    closedAt: new Date("2026-05-01T00:00:00.000Z"),
  },
]);

function candidate(input: {
  id: string;
  facility: string;
  createdAt: string;
  status?: ComplaintStatus;
  closedAt?: string;
}): SnapshotCandidate {
  const createdAt = new Date(input.createdAt);
  return {
    id: input.id,
    status: input.status ?? ComplaintStatus.OPEN,
    complaintDate: createdAt,
    receivedAt: createdAt,
    closedAt: input.closedAt ? new Date(input.closedAt) : null,
    sourceUpdatedAt: input.closedAt ? new Date(input.closedAt) : null,
    region: "منطقة الرياض",
    department: "إدارة الاختبار",
    classificationId: "classification-test",
    facility: input.facility,
    statusHistory: [],
  };
}

function snapshot(period: PeriodRange, candidates: SnapshotCandidate[]) {
  return computeExecutiveReportSnapshot(candidates, {
    currentPeriod: period,
    previousPeriod: null,
  }, { facilityRegistry: registry, strict: true });
}

describe("facility status in historical executive snapshots", () => {
  it("does not rewrite a period before closure, but excludes the same facility after closure", () => {
    const row = candidate({
      id: "historical",
      facility: "Facility C CLOSED",
      createdAt: "2026-06-15T00:00:00.000Z",
    });
    const june = snapshot({
      from: new Date("2026-06-01T00:00:00.000Z"),
      toExclusive: new Date("2026-07-01T00:00:00.000Z"),
    }, [row]);
    expect(june.current).toMatchObject({ receivedDuringPeriod: 1, openAtEnd: 1 });
    expect(june.byFacility["Facility C CLOSED"]).toBeDefined();

    const september = snapshot({
      from: new Date("2026-09-01T00:00:00.000Z"),
      toExclusive: new Date("2026-10-01T00:00:00.000Z"),
    }, [row]);
    expect(september.current).toMatchObject({
      receivedDuringPeriod: 0,
      closedDuringPeriod: 0,
      openAtEnd: 0,
      lateAtEnd: 0,
    });
    expect(september.byFacility["Facility C CLOSED"]).toBeUndefined();
    expect(september.byFacility["Facility D CLOSED"]).toBeUndefined();
  });

  it("counts pre-closure events, rejects post-closure events, and removes stock at period end", () => {
    const period = {
      from: new Date("2026-07-01T00:00:00.000Z"),
      toExclusive: new Date("2026-09-01T00:00:00.000Z"),
    };
    const rows = [
      candidate({ id: "received-before", facility: "Facility C CLOSED", createdAt: "2026-07-10T00:00:00Z" }),
      candidate({ id: "received-after", facility: "Facility C CLOSED", createdAt: "2026-08-02T00:00:00Z" }),
      candidate({
        id: "closed-before",
        facility: "Facility C CLOSED",
        createdAt: "2026-06-01T00:00:00Z",
        status: ComplaintStatus.CLOSED,
        closedAt: "2026-07-20T00:00:00Z",
      }),
      candidate({
        id: "closed-after",
        facility: "Facility C CLOSED",
        createdAt: "2026-06-02T00:00:00Z",
        status: ComplaintStatus.CLOSED,
        closedAt: "2026-08-02T00:00:00Z",
      }),
    ];
    const result = snapshot(period, rows);
    expect(result.current).toMatchObject({
      receivedDuringPeriod: 1,
      closedDuringPeriod: 1,
      openAtEnd: 0,
      lateAtEnd: 0,
    });
    expect(result.byFacility["Facility C CLOSED"]).toMatchObject({
      receivedDuringPeriod: 1,
      closedDuringPeriod: 1,
      openAtEnd: 0,
      lateAtEnd: 0,
    });
    expect(result.byRegion["منطقة الرياض"]?.receivedDuringPeriod).toBe(1);
    expect(result.byDepartment["إدارة الاختبار"]?.receivedDuringPeriod).toBe(1);
    expect(result.byClassification["classification-test"]?.receivedDuringPeriod).toBe(1);
  });

  it("left-joins ACTIVE zero-volume facilities and preserves their historical backlog", () => {
    const result = snapshot({
      from: new Date("2026-07-01T00:00:00.000Z"),
      toExclusive: new Date("2026-08-01T00:00:00.000Z"),
    }, [candidate({
      id: "backlog",
      facility: "Facility B ACTIVE",
      createdAt: "2026-06-01T00:00:00.000Z",
    })]);
    expect(result.byFacility["Facility A ACTIVE"]).toEqual({
      receivedDuringPeriod: 0,
      closedDuringPeriod: 0,
      openAtEnd: 0,
      lateAtEnd: 0,
    });
    expect(result.byFacility["Facility B ACTIVE"]).toMatchObject({
      receivedDuringPeriod: 0,
      openAtEnd: 1,
      lateAtEnd: 1,
    });
    expect(result.byFacility["Facility D CLOSED"]).toBeUndefined();
  });
});
