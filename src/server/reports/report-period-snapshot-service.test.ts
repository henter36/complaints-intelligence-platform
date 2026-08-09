import { describe, expect, it, vi, beforeEach } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import { COMPLAINT_SLA_DURATION_MS } from "@/server/complaints/complaint-sla-timing";
import type { PeriodRange } from "./report-comparison";
import {
  assertPeriodGroupReconciliation,
  composeSnapshotCandidateWhere,
  computeExecutiveReportSnapshot,
  loadReportPeriodSnapshotCandidates,
  resolveComplaintOpenStateAt,
  SnapshotReconciliationError,
  type ComplaintStatusHistoryEntry,
  type ReportPeriodGroupSnapshot,
  type SnapshotCandidate,
} from "./report-period-snapshot-service";
import type { ReportFilters } from "./report-definition-service";

const dbMocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      findMany: dbMocks.findMany,
    },
  },
}));

// Reference period from the task: [2026-07-26, 2026-08-03).
const CURRENT: PeriodRange = {
  from: new Date("2026-07-26T00:00:00.000Z"),
  toExclusive: new Date("2026-08-03T00:00:00.000Z"),
};
const PREVIOUS: PeriodRange = {
  from: new Date("2026-07-18T00:00:00.000Z"),
  toExclusive: new Date("2026-07-26T00:00:00.000Z"),
};
const NEXT: PeriodRange = {
  from: new Date("2026-08-03T00:00:00.000Z"),
  toExclusive: new Date("2026-08-11T00:00:00.000Z"),
};

function history(
  entries: Array<{ fromStatus: ComplaintStatus | null; toStatus: ComplaintStatus; changedAt: string }>
): ComplaintStatusHistoryEntry[] {
  return entries.map((e) => ({ ...e, changedAt: new Date(e.changedAt) }));
}

function candidate(overrides: Partial<SnapshotCandidate> & { id: string }): SnapshotCandidate {
  return {
    status: ComplaintStatus.OPEN,
    complaintDate: null,
    receivedAt: new Date("2026-07-01T00:00:00.000Z"),
    closedAt: null,
    sourceUpdatedAt: null,
    region: null,
    department: null,
    classificationId: null,
    facility: null,
    statusHistory: [],
    ...overrides,
  };
}

function baseFilters(overrides: Partial<ReportFilters> = {}): ReportFilters {
  return {
    from: "2026-07-26",
    to: "2026-08-02",
    ...overrides,
  } as ReportFilters;
}

describe("resolveComplaintOpenStateAt", () => {
  it("resolves open via the latest history entry strictly before measuredAt", () => {
    const result = resolveComplaintOpenStateAt({
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: null,
      sourceUpdatedAt: null,
      statusHistory: history([
        { fromStatus: null, toStatus: ComplaintStatus.NEW, changedAt: "2026-07-01T00:00:00.000Z" },
        { fromStatus: ComplaintStatus.NEW, toStatus: ComplaintStatus.OPEN, changedAt: "2026-07-27T00:00:00.000Z" },
      ]),
      measuredAt: CURRENT.toExclusive,
    });
    expect(result).toEqual({ isOpen: true, resolvedStatus: ComplaintStatus.OPEN, certain: true });
  });

  it("falls back to fromStatus of the earliest entry at/after measuredAt when no prior entry exists", () => {
    const result = resolveComplaintOpenStateAt({
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: new Date("2026-08-10T00:00:00.000Z"),
      sourceUpdatedAt: null,
      statusHistory: history([
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-08-10T00:00:00.000Z" },
      ]),
      measuredAt: CURRENT.toExclusive,
    });
    expect(result).toEqual({ isOpen: true, resolvedStatus: ComplaintStatus.OPEN, certain: true });
  });

  it("marks the state uncertain when a closed complaint has no trusted closure date and no history", () => {
    const result = resolveComplaintOpenStateAt({
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: null,
      sourceUpdatedAt: null,
      statusHistory: [],
      measuredAt: CURRENT.toExclusive,
    });
    expect(result).toEqual({ isOpen: false, resolvedStatus: null, certain: false });
  });

  it("treats a stray past closedAt on a currently-open complaint (no history) as uncertain, not open", () => {
    const result = resolveComplaintOpenStateAt({
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: new Date("2026-07-10T00:00:00.000Z"),
      sourceUpdatedAt: null,
      statusHistory: [],
      measuredAt: CURRENT.toExclusive,
    });
    expect(result.certain).toBe(false);
  });

  it("never treats CANCELLED as open via the fallback branch", () => {
    const result = resolveComplaintOpenStateAt({
      status: ComplaintStatus.CANCELLED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: null,
      sourceUpdatedAt: null,
      statusHistory: [],
      measuredAt: CURRENT.toExclusive,
    });
    expect(result).toEqual({ isOpen: false, resolvedStatus: ComplaintStatus.CANCELLED, certain: true });
  });
});

describe("resolveComplaintOpenStateAt — invalid changedAt (spec section 8/9)", () => {
  const INVALID_DATE = new Date(NaN);

  it("1. ignores an invalid-date entry and falls through to a valid prior entry", () => {
    const result = resolveComplaintOpenStateAt({
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: new Date("2026-07-28T00:00:00.000Z"),
      sourceUpdatedAt: null,
      statusHistory: [
        { fromStatus: null, toStatus: ComplaintStatus.OPEN, changedAt: INVALID_DATE },
        {
          fromStatus: ComplaintStatus.OPEN,
          toStatus: ComplaintStatus.CLOSED,
          changedAt: new Date("2026-07-28T00:00:00.000Z"),
        },
      ],
      measuredAt: CURRENT.toExclusive,
    });
    expect(result).toEqual({ isOpen: false, resolvedStatus: ComplaintStatus.CLOSED, certain: true });
  });

  it("2. ignores an invalid-date entry and falls through to a valid next entry", () => {
    const result = resolveComplaintOpenStateAt({
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: new Date("2026-08-10T00:00:00.000Z"),
      sourceUpdatedAt: null,
      statusHistory: [
        { fromStatus: ComplaintStatus.CLOSED, toStatus: ComplaintStatus.OPEN, changedAt: INVALID_DATE },
        {
          fromStatus: ComplaintStatus.OPEN,
          toStatus: ComplaintStatus.CLOSED,
          changedAt: new Date("2026-08-10T00:00:00.000Z"),
        },
      ],
      measuredAt: CURRENT.toExclusive,
    });
    expect(result).toEqual({ isOpen: true, resolvedStatus: ComplaintStatus.OPEN, certain: true });
  });

  it("3. uses the fallback when every history entry has an invalid date", () => {
    const result = resolveComplaintOpenStateAt({
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: null,
      sourceUpdatedAt: null,
      statusHistory: [
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: INVALID_DATE },
      ],
      measuredAt: CURRENT.toExclusive,
    });
    expect(result).toEqual({ isOpen: true, resolvedStatus: ComplaintStatus.OPEN, certain: true });
  });

  it("6. never throws or produces a NaN-derived state for a mix of invalid and valid entries", () => {
    expect(() =>
      resolveComplaintOpenStateAt({
        status: ComplaintStatus.CLOSED,
        complaintDate: new Date("2026-07-01T00:00:00.000Z"),
        receivedAt: new Date("2026-07-01T00:00:00.000Z"),
        closedAt: INVALID_DATE,
        sourceUpdatedAt: INVALID_DATE,
        statusHistory: [
          { fromStatus: null, toStatus: ComplaintStatus.OPEN, changedAt: INVALID_DATE },
          { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: INVALID_DATE },
        ],
        measuredAt: CURRENT.toExclusive,
      })
    ).not.toThrow();
  });
});

describe("wasComplaintClosedInWindow via computeExecutiveReportSnapshot — invalid closure transitions (spec section 9)", () => {
  const INVALID_DATE = new Date(NaN);

  it("4. an invalid-date closure transition does not block the effectiveClosedAt fallback", () => {
    const c = candidate({
      id: "invalid-transition-with-fallback",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: new Date("2026-07-28T00:00:00.000Z"),
      statusHistory: [
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: INVALID_DATE },
      ],
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.closedDuringPeriod).toBe(1);
  });

  it("5. an invalid-date closure transition with no usable fallback does not count as a closure", () => {
    const c = candidate({
      id: "invalid-transition-no-fallback",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: null,
      sourceUpdatedAt: null,
      statusHistory: [
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: INVALID_DATE },
      ],
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.closedDuringPeriod).toBe(0);
  });

  it("6. never throws for a candidate list mixing invalid and valid closure transitions", () => {
    const candidates = [
      candidate({
        id: "mix-1",
        status: ComplaintStatus.CLOSED,
        complaintDate: new Date("2026-07-01T00:00:00.000Z"),
        closedAt: new Date("2026-07-28T00:00:00.000Z"),
        statusHistory: [
          { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: INVALID_DATE },
        ],
      }),
      candidate({
        id: "mix-2",
        status: ComplaintStatus.CLOSED,
        complaintDate: new Date("2026-07-01T00:00:00.000Z"),
        statusHistory: [
          { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: new Date("2026-07-29T00:00:00.000Z") },
        ],
      }),
    ];
    expect(() =>
      computeExecutiveReportSnapshot(candidates, { currentPeriod: CURRENT, previousPeriod: null })
    ).not.toThrow();
  });
});

describe("computeExecutiveReportSnapshot — functional scenarios (spec section 19)", () => {
  it("1. created before period, still open: excluded from receivedDuringPeriod, included in openAtEnd and lateAtEnd", () => {
    const c = candidate({
      id: "c1",
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.receivedDuringPeriod).toBe(0);
    expect(snapshot.current.openAtEnd).toBe(1);
    expect(snapshot.current.lateAtEnd).toBe(1);
  });

  it("2. created during period, closed after period end: received, not closedDuringPeriod, still openAtEnd", () => {
    const c = candidate({
      id: "c2",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-27T00:00:00.000Z"),
      closedAt: new Date("2026-08-10T00:00:00.000Z"),
      statusHistory: history([
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-08-10T00:00:00.000Z" },
      ]),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.receivedDuringPeriod).toBe(1);
    expect(snapshot.current.closedDuringPeriod).toBe(0);
    expect(snapshot.current.openAtEnd).toBe(1);
  });

  it("3. created before period, closed during period: not received, closedDuringPeriod, not openAtEnd", () => {
    const c = candidate({
      id: "c3",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: new Date("2026-07-28T00:00:00.000Z"),
      statusHistory: history([
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-07-28T00:00:00.000Z" },
      ]),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.receivedDuringPeriod).toBe(0);
    expect(snapshot.current.closedDuringPeriod).toBe(1);
    expect(snapshot.current.openAtEnd).toBe(0);
  });

  it("4. closed then reopened before period end: closedDuringPeriod, openAtEnd, may be late", () => {
    const c = candidate({
      id: "c4",
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      statusHistory: history([
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-07-27T00:00:00.000Z" },
        { fromStatus: ComplaintStatus.CLOSED, toStatus: ComplaintStatus.OPEN, changedAt: "2026-07-29T00:00:00.000Z" },
      ]),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.closedDuringPeriod).toBe(1);
    expect(snapshot.current.openAtEnd).toBe(1);
    expect(snapshot.current.lateAtEnd).toBe(1);
  });

  it("5. closed before period end then reopened after: not openAtEnd, closedDuringPeriod counted", () => {
    const c = candidate({
      id: "c5",
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      statusHistory: history([
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-07-28T00:00:00.000Z" },
        { fromStatus: ComplaintStatus.CLOSED, toStatus: ComplaintStatus.OPEN, changedAt: "2026-08-10T00:00:00.000Z" },
      ]),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.openAtEnd).toBe(0);
    expect(snapshot.current.closedDuringPeriod).toBe(1);
  });

  it("6. CANCELLED before period end: excluded from openAtEnd, lateAtEnd, and closedDuringPeriod", () => {
    const c = candidate({
      id: "c6",
      status: ComplaintStatus.CANCELLED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      statusHistory: history([
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CANCELLED, changedAt: "2026-07-15T00:00:00.000Z" },
      ]),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.openAtEnd).toBe(0);
    expect(snapshot.current.lateAtEnd).toBe(0);
    expect(snapshot.current.closedDuringPeriod).toBe(0);
  });

  it("7. CLOSED transition exactly at toExclusive: excluded from current period, included in the next", () => {
    const c = candidate({
      id: "c7",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: new Date("2026-08-03T00:00:00.000Z"),
      statusHistory: history([
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-08-03T00:00:00.000Z" },
      ]),
    });
    const currentSnapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(currentSnapshot.current.closedDuringPeriod).toBe(0);
    const nextSnapshot = computeExecutiveReportSnapshot([c], { currentPeriod: NEXT, previousPeriod: null });
    expect(nextSnapshot.current.closedDuringPeriod).toBe(1);
  });

  it("8. created exactly at toExclusive: excluded from receivedDuringPeriod and openAtEnd for the current period", () => {
    const c = candidate({
      id: "c8",
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-08-03T00:00:00.000Z"),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.receivedDuringPeriod).toBe(0);
    expect(snapshot.current.openAtEnd).toBe(0);
  });

  it("9. RESOLVED then CLOSED inside the period counts once, not twice", () => {
    const c = candidate({
      id: "c9",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      statusHistory: history([
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.RESOLVED, changedAt: "2026-07-27T00:00:00.000Z" },
        { fromStatus: ComplaintStatus.RESOLVED, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-07-29T00:00:00.000Z" },
      ]),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.closedDuringPeriod).toBe(1);
  });

  it("10. valid closedAt with no history uses the fallback path", () => {
    const c = candidate({
      id: "c10",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: new Date("2026-07-28T00:00:00.000Z"),
      statusHistory: [],
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.closedDuringPeriod).toBe(1);
  });

  it("11. closedAt older than createdAt uses the central fallback via sourceUpdatedAt", () => {
    const c = candidate({
      id: "c11",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-20T00:00:00.000Z"),
      closedAt: new Date("2026-07-01T00:00:00.000Z"), // before creation — untrusted
      sourceUpdatedAt: new Date("2026-07-29T00:00:00.000Z"),
      statusHistory: [],
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.closedDuringPeriod).toBe(1);
  });

  it("regression: a bulk-import creation record (fromStatus: null, toStatus: CLOSED, changedAt = import time) is not treated as a real closure event", () => {
    // Real dev.db shape: complaints imported already-closed get exactly one
    // ComplaintStatusHistory row — { fromStatus: null, toStatus: CLOSED,
    // changedAt: <import processing time>, reason: "Created from confirmed
    // import" } — which is NOT the real historical closure date. Without the
    // fromStatus !== null guard, closedDuringPeriod was always 0 for imported
    // data because changedAt (today) never falls inside a past report period,
    // and the closedAt-based fallback was wrongly skipped because the
    // complaint appeared to already have a "closure transition".
    const importedClosedAt = new Date("2026-07-28T00:00:00.000Z"); // real closure date, trustworthy
    const c = candidate({
      id: "imported-1",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: importedClosedAt,
      statusHistory: history([
        // import processing time — long after the report period, not the real closure date
        { fromStatus: null, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-08-06T12:00:00.000Z" },
      ]),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    // Falls back to closedAt (2026-07-28), which is inside CURRENT_PERIOD.
    expect(snapshot.current.closedDuringPeriod).toBe(1);
    // Also correctly resolved as not-open at period end via the same fallback.
    expect(snapshot.current.openAtEnd).toBe(0);
  });

  it("a genuine fromStatus-carrying transition still counts normally alongside a leading creation record", () => {
    const c = candidate({
      id: "imported-2",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      statusHistory: history([
        { fromStatus: null, toStatus: ComplaintStatus.OPEN, changedAt: "2026-08-06T12:00:00.000Z" },
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-07-29T00:00:00.000Z" },
      ]),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.closedDuringPeriod).toBe(1);
  });

  it("12. deadline exactly equal to period.toExclusive is not late", () => {
    const createdAt = new Date(CURRENT.toExclusive.getTime() - COMPLAINT_SLA_DURATION_MS);
    const c = candidate({ id: "c12", status: ComplaintStatus.OPEN, complaintDate: createdAt });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.openAtEnd).toBe(1);
    expect(snapshot.current.lateAtEnd).toBe(0);
  });

  it("13. deadline one millisecond before period.toExclusive is late", () => {
    const createdAt = new Date(CURRENT.toExclusive.getTime() - COMPLAINT_SLA_DURATION_MS - 1);
    const c = candidate({ id: "c13", status: ComplaintStatus.OPEN, complaintDate: createdAt });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.current.lateAtEnd).toBe(1);
  });

  it("14. a CANCELLED complaint under a classification never pushes the classification sum above the overall total", () => {
    const candidates = [
      candidate({
        id: "c14a",
        status: ComplaintStatus.OPEN,
        complaintDate: new Date("2026-07-01T00:00:00.000Z"),
        classificationId: "cls-a",
      }),
      candidate({
        id: "c14b",
        status: ComplaintStatus.CANCELLED,
        complaintDate: new Date("2026-07-01T00:00:00.000Z"),
        classificationId: "cls-a",
        statusHistory: history([
          { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CANCELLED, changedAt: "2026-07-10T00:00:00.000Z" },
        ]),
      }),
    ];
    const snapshot = computeExecutiveReportSnapshot(candidates, { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.byClassification["cls-a"]?.openAtEnd).toBe(1);
    expect(snapshot.current.openAtEnd).toBe(1);
  });

  it("15. complaint without classificationId lands in the unclassified bucket", () => {
    const c = candidate({
      id: "c15",
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      classificationId: null,
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    const keys = Object.keys(snapshot.byClassification);
    expect(keys).toHaveLength(1);
    expect(snapshot.byClassification[keys[0]!]?.openAtEnd).toBe(1);
  });

  it("16. complaint without region, department, or facility lands in the unspecified bucket and is not dropped from reconciliation", () => {
    const c = candidate({
      id: "c16",
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      region: null,
      department: null,
      facility: null,
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    const regionSum = Object.values(snapshot.byRegion).reduce((s, g) => s + g.openAtEnd, 0);
    const deptSum = Object.values(snapshot.byDepartment).reduce((s, g) => s + g.openAtEnd, 0);
    const facilitySum = Object.values(snapshot.byFacility).reduce((s, g) => s + g.openAtEnd, 0);
    expect(regionSum).toBe(snapshot.current.openAtEnd);
    expect(deptSum).toBe(snapshot.current.openAtEnd);
    expect(facilitySum).toBe(snapshot.current.openAtEnd);
    expect(Object.keys(snapshot.byFacility)).toEqual(["غير محدد"]);
  });
});

describe("computeExecutiveReportSnapshot — byFacility grouping (spec section 17 items 1-5)", () => {
  it("1. a complaint created before the period and still open at period end appears in its facility's openAtEnd and lateAtEnd (prior-period backlog carried forward)", () => {
    const c = candidate({
      id: "f1",
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      facility: "سجن الرياض",
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.byFacility["سجن الرياض"]?.receivedDuringPeriod).toBe(0);
    expect(snapshot.byFacility["سجن الرياض"]?.openAtEnd).toBe(1);
    expect(snapshot.byFacility["سجن الرياض"]?.lateAtEnd).toBe(1);
  });

  it("2. facilities are computed with the same historical evidence order as regions/departments/classifications", () => {
    const c = candidate({
      id: "f2",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: new Date("2026-07-28T00:00:00.000Z"),
      facility: "سجن جدة",
      statusHistory: history([
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-07-28T00:00:00.000Z" },
      ]),
    });
    const snapshot = computeExecutiveReportSnapshot([c], { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.byFacility["سجن جدة"]?.receivedDuringPeriod).toBe(0);
    expect(snapshot.byFacility["سجن جدة"]?.closedDuringPeriod).toBe(1);
    expect(snapshot.byFacility["سجن جدة"]?.openAtEnd).toBe(0);
  });

  it("3. receivedDuringPeriod/openAtEnd/lateAtEnd sum across facilities back to the overall snapshot (reconciliation)", () => {
    const candidates = [
      candidate({ id: "f3a", status: ComplaintStatus.OPEN, complaintDate: new Date("2026-01-01T00:00:00.000Z"), facility: "سجن الرياض" }),
      candidate({ id: "f3b", status: ComplaintStatus.OPEN, complaintDate: new Date("2026-07-30T00:00:00.000Z"), facility: null }),
      candidate({
        id: "f3c",
        status: ComplaintStatus.CLOSED,
        complaintDate: new Date("2026-01-01T00:00:00.000Z"),
        closedAt: new Date("2026-07-27T00:00:00.000Z"),
        statusHistory: history([{ fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-07-27T00:00:00.000Z" }]),
        facility: "سجن جدة",
      }),
    ];
    const snapshot = computeExecutiveReportSnapshot(candidates, { currentPeriod: CURRENT, previousPeriod: null });
    const sums = Object.values(snapshot.byFacility).reduce(
      (acc, g) => ({
        receivedDuringPeriod: acc.receivedDuringPeriod + g.receivedDuringPeriod,
        openAtEnd: acc.openAtEnd + g.openAtEnd,
        lateAtEnd: acc.lateAtEnd + g.lateAtEnd,
      }),
      { receivedDuringPeriod: 0, openAtEnd: 0, lateAtEnd: 0 }
    );
    expect(sums.receivedDuringPeriod).toBe(snapshot.current.receivedDuringPeriod);
    expect(sums.openAtEnd).toBe(snapshot.current.openAtEnd);
    expect(sums.lateAtEnd).toBe(snapshot.current.lateAtEnd);
  });

  it("4. a CANCELLED complaint under a facility never pushes the facility's openAtEnd above the overall total", () => {
    const candidates = [
      candidate({ id: "f4a", status: ComplaintStatus.OPEN, complaintDate: new Date("2026-07-01T00:00:00.000Z"), facility: "سجن الرياض" }),
      candidate({
        id: "f4b",
        status: ComplaintStatus.CANCELLED,
        complaintDate: new Date("2026-07-01T00:00:00.000Z"),
        facility: "سجن الرياض",
        statusHistory: history([
          { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CANCELLED, changedAt: "2026-07-10T00:00:00.000Z" },
        ]),
      }),
    ];
    const snapshot = computeExecutiveReportSnapshot(candidates, { currentPeriod: CURRENT, previousPeriod: null });
    expect(snapshot.byFacility["سجن الرياض"]?.openAtEnd).toBe(1);
    expect(snapshot.current.openAtEnd).toBe(1);
  });

  it("5. lateAtEnd never exceeds openAtEnd for any facility bucket", () => {
    const candidates = [
      candidate({ id: "f5a", status: ComplaintStatus.OPEN, complaintDate: new Date("2026-01-01T00:00:00.000Z"), facility: "سجن الرياض" }),
      candidate({ id: "f5b", status: ComplaintStatus.OPEN, complaintDate: new Date("2026-07-30T00:00:00.000Z"), facility: "سجن الرياض" }),
    ];
    const snapshot = computeExecutiveReportSnapshot(candidates, { currentPeriod: CURRENT, previousPeriod: PREVIOUS });
    for (const group of Object.values(snapshot.byFacility)) {
      expect(group.lateAtEnd).toBeLessThanOrEqual(group.openAtEnd);
    }
  });
});

describe("computeExecutiveReportSnapshot — uncertain-complaint warning deduplication (spec section 11)", () => {
  function uncertainCandidate(id: string, overrides: Partial<SnapshotCandidate> = {}): SnapshotCandidate {
    // CLOSED with no closedAt, no sourceUpdatedAt, and no statusHistory: every
    // aggregation pass (current, previous, byRegion, byDepartment,
    // byClassification) independently resolves this complaint as "uncertain".
    return candidate({
      id,
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: null,
      sourceUpdatedAt: null,
      statusHistory: [],
      region: "الرياض",
      department: "الطوارئ",
      classificationId: "cls-a",
      ...overrides,
    });
  }

  it("one uncertain complaint evaluated across the overall snapshot and three dimensions produces exactly one warning", () => {
    const snapshot = computeExecutiveReportSnapshot(
      [uncertainCandidate("uncertain-1")],
      { currentPeriod: CURRENT, previousPeriod: PREVIOUS }
    );
    const matching = snapshot.warnings.filter((w) => w.includes("uncertain-1"));
    expect(matching).toHaveLength(1);
  });

  it("two distinct uncertain complaints produce two distinct warning messages", () => {
    const snapshot = computeExecutiveReportSnapshot(
      [uncertainCandidate("uncertain-a"), uncertainCandidate("uncertain-b")],
      { currentPeriod: CURRENT, previousPeriod: PREVIOUS }
    );
    expect(snapshot.warnings.filter((w) => w.includes("uncertain-a"))).toHaveLength(1);
    expect(snapshot.warnings.filter((w) => w.includes("uncertain-b"))).toHaveLength(1);
    expect(new Set(snapshot.warnings).size).toBe(snapshot.warnings.length);
  });

  it("reconciliation warnings are independent of the uncertain-complaint Set and still absent when sums naturally hold", () => {
    const snapshot = computeExecutiveReportSnapshot(
      [uncertainCandidate("uncertain-1"), uncertainCandidate("uncertain-2")],
      { currentPeriod: CURRENT, previousPeriod: PREVIOUS },
      { strict: false }
    );
    const reconciliationWarnings = snapshot.warnings.filter((w) => w.includes("مصالحة") || w.includes("مطابق"));
    expect(reconciliationWarnings).toHaveLength(0);
    expect(snapshot.warnings).toHaveLength(2);
  });
});

describe("computeExecutiveReportSnapshot — reconciliation (spec section 20)", () => {
  it("lateAtEnd never exceeds openAtEnd for the overall, region, department, and classification snapshots", () => {
    const candidates = [
      candidate({ id: "r1", status: ComplaintStatus.OPEN, complaintDate: new Date("2026-01-01T00:00:00.000Z"), region: "الرياض", department: "الطوارئ", classificationId: "cls-a" }),
      candidate({ id: "r2", status: ComplaintStatus.OPEN, complaintDate: new Date("2026-07-30T00:00:00.000Z"), region: "الرياض", department: "العيادات", classificationId: "cls-b" }),
      candidate({ id: "r3", status: ComplaintStatus.CLOSED, complaintDate: new Date("2026-06-01T00:00:00.000Z"), closedAt: new Date("2026-06-05T00:00:00.000Z"), region: "مكة", department: "الطوارئ", classificationId: "cls-a" }),
    ];
    const snapshot = computeExecutiveReportSnapshot(candidates, { currentPeriod: CURRENT, previousPeriod: PREVIOUS });
    expect(snapshot.current.lateAtEnd).toBeLessThanOrEqual(snapshot.current.openAtEnd);
    for (const group of Object.values(snapshot.byRegion)) {
      expect(group.lateAtEnd).toBeLessThanOrEqual(group.openAtEnd);
    }
    for (const group of Object.values(snapshot.byDepartment)) {
      expect(group.lateAtEnd).toBeLessThanOrEqual(group.openAtEnd);
    }
    for (const group of Object.values(snapshot.byClassification)) {
      expect(group.lateAtEnd).toBeLessThanOrEqual(group.openAtEnd);
    }
  });

  it("sums receivedDuringPeriod, openAtEnd, and lateAtEnd across regions/departments/classifications back to the overall", () => {
    const candidates = [
      candidate({ id: "s1", status: ComplaintStatus.OPEN, complaintDate: new Date("2026-01-01T00:00:00.000Z"), region: "الرياض", department: "الطوارئ", classificationId: "cls-a" }),
      candidate({ id: "s2", status: ComplaintStatus.OPEN, complaintDate: new Date("2026-07-30T00:00:00.000Z"), region: null, department: null, classificationId: null }),
      candidate({
        id: "s3",
        status: ComplaintStatus.CLOSED,
        complaintDate: new Date("2026-01-01T00:00:00.000Z"),
        closedAt: new Date("2026-07-27T00:00:00.000Z"),
        statusHistory: history([{ fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-07-27T00:00:00.000Z" }]),
        region: "مكة",
        department: "العيادات",
        classificationId: "cls-b",
      }),
    ];
    const snapshot = computeExecutiveReportSnapshot(candidates, { currentPeriod: CURRENT, previousPeriod: null });
    for (const groups of [snapshot.byRegion, snapshot.byDepartment, snapshot.byClassification]) {
      const sums = Object.values(groups).reduce(
        (acc, g) => ({
          receivedDuringPeriod: acc.receivedDuringPeriod + g.receivedDuringPeriod,
          openAtEnd: acc.openAtEnd + g.openAtEnd,
          lateAtEnd: acc.lateAtEnd + g.lateAtEnd,
        }),
        { receivedDuringPeriod: 0, openAtEnd: 0, lateAtEnd: 0 }
      );
      expect(sums.receivedDuringPeriod).toBe(snapshot.current.receivedDuringPeriod);
      expect(sums.openAtEnd).toBe(snapshot.current.openAtEnd);
      expect(sums.lateAtEnd).toBe(snapshot.current.lateAtEnd);
    }
  });

  it("assertPeriodGroupReconciliation throws a SnapshotReconciliationError on drift, without rounding it away", () => {
    const overall: ReportPeriodGroupSnapshot = {
      receivedDuringPeriod: 10,
      closedDuringPeriod: 5,
      openAtEnd: 8,
      lateAtEnd: 3,
    };
    const groups: Record<string, ReportPeriodGroupSnapshot> = {
      a: { receivedDuringPeriod: 5, closedDuringPeriod: 2, openAtEnd: 4, lateAtEnd: 1 },
      b: { receivedDuringPeriod: 4, closedDuringPeriod: 3, openAtEnd: 3, lateAtEnd: 1 }, // sums to 9, not 10
    };
    expect(() =>
      assertPeriodGroupReconciliation({ dimensionLabel: "test", overall, groups })
    ).toThrow(SnapshotReconciliationError);
  });

  it("assertPeriodGroupReconciliation does not throw when sums match exactly", () => {
    const overall: ReportPeriodGroupSnapshot = {
      receivedDuringPeriod: 9,
      closedDuringPeriod: 5,
      openAtEnd: 7,
      lateAtEnd: 2,
    };
    const groups: Record<string, ReportPeriodGroupSnapshot> = {
      a: { receivedDuringPeriod: 5, closedDuringPeriod: 2, openAtEnd: 4, lateAtEnd: 1 },
      b: { receivedDuringPeriod: 4, closedDuringPeriod: 3, openAtEnd: 3, lateAtEnd: 1 },
    };
    expect(() =>
      assertPeriodGroupReconciliation({ dimensionLabel: "test", overall, groups })
    ).not.toThrow();
  });
});

describe("computeExecutiveReportSnapshot — status filter (spec section 8)", () => {
  const candidates = [
    candidate({ id: "o1", status: ComplaintStatus.OPEN, complaintDate: new Date("2026-07-01T00:00:00.000Z") }),
    candidate({
      id: "cl1",
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: new Date("2026-07-10T00:00:00.000Z"),
      statusHistory: history([
        { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: "2026-07-10T00:00:00.000Z" },
      ]),
    }),
  ];

  it("status=OPEN restricts the snapshot to complaints resolved as OPEN at period end", () => {
    const snapshot = computeExecutiveReportSnapshot(candidates, {
      currentPeriod: CURRENT,
      previousPeriod: null,
    }, { statusFilter: ComplaintStatus.OPEN });
    expect(snapshot.current.openAtEnd).toBe(1);
  });

  it("status=CLOSED restricts the snapshot to complaints resolved as CLOSED at period end", () => {
    const snapshot = computeExecutiveReportSnapshot(candidates, {
      currentPeriod: CURRENT,
      previousPeriod: null,
    }, { statusFilter: ComplaintStatus.CLOSED });
    expect(snapshot.current.openAtEnd).toBe(0);
    expect(snapshot.current.receivedDuringPeriod).toBe(0);
  });
});

describe("computeExecutiveReportSnapshot — input immutability", () => {
  it("does not mutate the candidates array or its statusHistory entries", () => {
    const c = candidate({
      id: "im1",
      status: ComplaintStatus.OPEN,
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      statusHistory: Object.freeze(
        history([{ fromStatus: null, toStatus: ComplaintStatus.OPEN, changedAt: "2026-07-01T00:00:00.000Z" }])
      ) as ComplaintStatusHistoryEntry[],
    });
    const frozenList = Object.freeze([c]);
    expect(() =>
      computeExecutiveReportSnapshot(frozenList, { currentPeriod: CURRENT, previousPeriod: null })
    ).not.toThrow();
  });
});

describe("loadReportPeriodSnapshotCandidates — query shape (spec section 7)", () => {
  beforeEach(() => {
    dbMocks.findMany.mockReset();
  });

  it("issues exactly one findMany, strips from/to/status, and selects only the narrow projection", async () => {
    dbMocks.findMany.mockResolvedValue([]);
    await loadReportPeriodSnapshotCandidates(baseFilters({ status: ComplaintStatus.OPEN }), new Date(), CURRENT.toExclusive);

    expect(dbMocks.findMany).toHaveBeenCalledTimes(1);
    const call = dbMocks.findMany.mock.calls[0]![0];
    expect(call.where.status).toBeUndefined();
    expect(call.select).toEqual({
      id: true,
      status: true,
      complaintDate: true,
      receivedAt: true,
      closedAt: true,
      sourceUpdatedAt: true,
      region: true,
      department: true,
      classificationId: true,
      facility: true,
      statusHistory: { select: { fromStatus: true, toStatus: true, changedAt: true } },
    });
    for (const forbidden of [
      "description",
      "sourceDetail",
      "actionDescription",
      "complainantName",
      "complainantIdentifier",
      "complainantPhone",
      "sourceUpdatedBy",
      "sourceClosedBy",
    ]) {
      expect(call.select).not.toHaveProperty(forbidden);
    }
  });

  it("composes the final where with AND so the base filter's own OR survives alongside the createdBefore OR (spec section 13)", async () => {
    dbMocks.findMany.mockResolvedValue([]);
    await loadReportPeriodSnapshotCandidates(baseFilters(), new Date(), CURRENT.toExclusive);

    const call = dbMocks.findMany.mock.calls[0]![0];
    expect(Array.isArray(call.where.AND)).toBe(true);
    expect(call.where.AND).toHaveLength(3);
    expect(call.where.AND[1]).toEqual({ isDeleted: false });
    expect(call.where.AND[2]).toEqual({
      OR: [
        { complaintDate: { lt: CURRENT.toExclusive } },
        { complaintDate: null, receivedAt: { lt: CURRENT.toExclusive } },
      ],
    });
    // No top-level `where.OR`/`where.isDeleted` clobbering anything from baseWhere.
    expect(call.where.OR).toBeUndefined();
  });
});

describe("composeSnapshotCandidateWhere (spec section 12-13)", () => {
  it("wraps baseWhere, isDeleted, and createdBeforeWhere in AND — never a spread that could drop an existing OR", () => {
    const toExclusive = new Date("2026-08-03T00:00:00.000Z");
    const baseWhere = {
      OR: [{ subject: { contains: "نقل" } }, { description: { contains: "نقل" } }],
      region: "الرياض",
    };

    const result = composeSnapshotCandidateWhere(baseWhere, toExclusive);

    expect(result).toEqual({
      AND: [
        baseWhere,
        { isDeleted: false },
        {
          OR: [
            { complaintDate: { lt: toExclusive } },
            { complaintDate: null, receivedAt: { lt: toExclusive } },
          ],
        },
      ],
    });
    // baseWhere's own OR is preserved verbatim as the first AND member, not merged/overwritten.
    expect((result.AND as unknown[])[0]).toBe(baseWhere);
  });

  it("still composes correctly when baseWhere has no OR of its own", () => {
    const toExclusive = new Date("2026-08-03T00:00:00.000Z");
    const baseWhere = { region: "الرياض", priority: "HIGH" as const };

    const result = composeSnapshotCandidateWhere(baseWhere, toExclusive);

    expect(result).toEqual({
      AND: [
        baseWhere,
        { isDeleted: false },
        {
          OR: [
            { complaintDate: { lt: toExclusive } },
            { complaintDate: null, receivedAt: { lt: toExclusive } },
          ],
        },
      ],
    });
  });
});
