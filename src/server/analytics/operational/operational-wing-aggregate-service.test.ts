import { describe, expect, it, vi, beforeEach } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import { buildComplaintTiming } from "@/server/complaints/complaint-timing";
import {
  CLOSED_COMPLAINT_STATUSES,
  OPEN_COMPLAINT_STATUSES,
} from "@/server/complaints/status";
import { categoricalKey, categoricalLabel } from "./operational-aggregate-service";
import {
  OPERATIONAL_UNSPECIFIED,
  type WingOperationalMetrics,
} from "./operational-analytics-types";
import {
  applyWingClassificationGroups,
  applyWingLateGroups,
  buildWingMetricsFromAggregates,
  loadWingOperationalMetrics,
  mergeWingStatusGroups,
  pickTopClassification,
} from "./operational-wing-aggregate-service";

const dbMocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  groupBy: vi.fn(),
  classificationFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      findMany: dbMocks.findMany,
      groupBy: dbMocks.groupBy,
    },
    classification: {
      findMany: dbMocks.classificationFindMany,
    },
  },
}));

const NOW = new Date("2026-08-05T12:00:00.000Z");

type ReferenceWingRow = {
  status: ComplaintStatus;
  wingCode: string | null;
  classification: { id: string; nameAr: string } | null;
  complaintDate: Date | null;
  receivedAt: Date;
  dueDate: Date | null;
  closedAt: Date | null;
};

/** Legacy in-memory wing builder retained as the parity reference. */
function referenceBuildWingMetrics(
  rows: ReferenceWingRow[],
  now: Date,
  total: number
): WingOperationalMetrics {
  const byWing = new Map<string, ReferenceWingRow[]>();
  for (const row of rows) {
    const key = categoricalKey(row.wingCode);
    const list = byWing.get(key) ?? [];
    list.push(row);
    byWing.set(key, list);
  }

  const items = Array.from(byWing.entries())
    .filter(([key]) => key !== OPERATIONAL_UNSPECIFIED)
    .map(([key, itemsForWing]) => {
      let open = 0;
      let closed = 0;
      let currentlyLate = 0;
      const classCounts = new Map<string, { count: number; id: string }>();
      for (const row of itemsForWing) {
        if (OPEN_COMPLAINT_STATUSES.has(row.status)) open += 1;
        if (CLOSED_COMPLAINT_STATUSES.has(row.status)) closed += 1;
        if (buildComplaintTiming(row, now).isCurrentlyLate) currentlyLate += 1;
        const className = row.classification?.nameAr;
        const classId = row.classification?.id;
        if (className && classId) {
          const existing = classCounts.get(className);
          if (existing) {
            existing.count += 1;
          } else {
            classCounts.set(className, { count: 1, id: classId });
          }
        }
      }
      const top =
        Array.from(classCounts.entries())
          .map(([nameAr, entry]) => ({ nameAr, ...entry }))
          .sort(
            (a, b) =>
              b.count - a.count
              || a.nameAr.localeCompare(b.nameAr, "ar")
              || a.id.localeCompare(b.id)
          )[0] ?? null;
      return {
        key,
        label: categoricalLabel(key),
        count: itemsForWing.length,
        percentage: total <= 0 ? 0 : Math.round((itemsForWing.length / total) * 1000) / 10,
        open,
        closed,
        currentlyLate,
        topClassification: top?.nameAr ?? null,
        topClassificationCount: top?.count ?? 0,
        drillDownFilters: { wingCode: key },
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ar"))
    .slice(0, 40);

  return {
    items,
    unspecifiedCount: byWing.get(OPERATIONAL_UNSPECIFIED)?.length ?? 0,
    total,
  };
}

function aggregatesFromRows(rows: ReferenceWingRow[], now: Date) {
  const statusGroups = new Map<string, { status: ComplaintStatus; count: number; wingCode: string | null }>();
  for (const row of rows) {
    const indexKey = `${row.wingCode === null ? "__null__" : JSON.stringify(row.wingCode)}|${row.status}`;
    const existing = statusGroups.get(indexKey);
    if (existing) {
      existing.count += 1;
      continue;
    }
    statusGroups.set(indexKey, { wingCode: row.wingCode, status: row.status, count: 1 });
  }

  const buckets = mergeWingStatusGroups([...statusGroups.values()]);

  const lateByRaw = new Map<string | null, number>();
  for (const row of rows) {
    if (!buildComplaintTiming(row, now).isCurrentlyLate) continue;
    lateByRaw.set(row.wingCode, (lateByRaw.get(row.wingCode) ?? 0) + 1);
  }
  applyWingLateGroups(
    buckets,
    [...lateByRaw.entries()].map(([wingCode, count]) => ({ wingCode, count }))
  );

  const classGroups = new Map<string, { wingCode: string | null; classificationId: string | null; count: number }>();
  const namesById = new Map<string, string>();
  for (const row of rows) {
    const classificationId = row.classification?.id ?? null;
    if (row.classification) namesById.set(row.classification.id, row.classification.nameAr);
    const indexKey = `${row.wingCode === null ? "__null__" : JSON.stringify(row.wingCode)}|${classificationId ?? "__null__"}`;
    const existing = classGroups.get(indexKey);
    if (existing) {
      existing.count += 1;
      continue;
    }
    classGroups.set(indexKey, {
      wingCode: row.wingCode,
      classificationId,
      count: 1,
    });
  }
  applyWingClassificationGroups(buckets, [...classGroups.values()]);

  return { buckets, namesById };
}

function createParityDataset(): ReferenceWingRow[] {
  const receivedAt = new Date("2026-07-01T08:00:00.000Z");
  return [
    {
      status: ComplaintStatus.OPEN,
      wingCode: "W1",
      classification: { id: "cls-a", nameAr: "مواعيد" },
      complaintDate: receivedAt,
      receivedAt,
      dueDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: null,
    },
    {
      status: ComplaintStatus.IN_PROGRESS,
      wingCode: "W1",
      classification: { id: "cls-a", nameAr: "مواعيد" },
      complaintDate: receivedAt,
      receivedAt,
      dueDate: new Date("2026-08-20T00:00:00.000Z"),
      closedAt: null,
    },
    {
      status: ComplaintStatus.CLOSED,
      wingCode: "W1",
      classification: { id: "cls-b", nameAr: "سلوك" },
      complaintDate: receivedAt,
      receivedAt,
      dueDate: null,
      closedAt: new Date("2026-07-05T00:00:00.000Z"),
    },
    {
      status: ComplaintStatus.OPEN,
      wingCode: "W2",
      classification: { id: "cls-b", nameAr: "سلوك" },
      complaintDate: receivedAt,
      receivedAt,
      dueDate: new Date("2026-08-01T00:00:00.000Z"),
      closedAt: null,
    },
    {
      status: ComplaintStatus.NEW,
      wingCode: null,
      classification: null,
      complaintDate: receivedAt,
      receivedAt,
      dueDate: new Date("2026-08-10T00:00:00.000Z"),
      closedAt: null,
    },
    {
      status: ComplaintStatus.CLOSED,
      wingCode: "",
      classification: { id: "cls-a", nameAr: "مواعيد" },
      complaintDate: receivedAt,
      receivedAt,
      dueDate: null,
      closedAt: new Date("2026-07-02T00:00:00.000Z"),
    },
    {
      status: ComplaintStatus.RESOLVED,
      wingCode: "  ",
      classification: null,
      complaintDate: receivedAt,
      receivedAt,
      dueDate: null,
      closedAt: new Date("2026-07-03T00:00:00.000Z"),
    },
    {
      status: ComplaintStatus.CLOSED,
      wingCode: "W3",
      classification: null,
      complaintDate: receivedAt,
      receivedAt,
      dueDate: null,
      closedAt: new Date("2026-07-04T00:00:00.000Z"),
    },
  ];
}

describe("operational wing aggregate helpers", () => {
  it("merges null, empty, and whitespace wing codes into unspecified", () => {
    const buckets = mergeWingStatusGroups([
      { wingCode: null, status: ComplaintStatus.OPEN, count: 2 },
      { wingCode: "", status: ComplaintStatus.CLOSED, count: 1 },
      { wingCode: "   ", status: ComplaintStatus.NEW, count: 3 },
    ]);
    expect(buckets.get(OPERATIONAL_UNSPECIFIED)).toMatchObject({
      count: 6,
      open: 5,
      closed: 1,
    });
  });

  it("sums open and closed across statuses for the same wing", () => {
    const buckets = mergeWingStatusGroups([
      { wingCode: "W1", status: ComplaintStatus.OPEN, count: 2 },
      { wingCode: "W1", status: ComplaintStatus.IN_PROGRESS, count: 1 },
      { wingCode: "W1", status: ComplaintStatus.CLOSED, count: 4 },
    ]);
    expect(buckets.get("W1")).toMatchObject({ count: 7, open: 3, closed: 4 });
  });

  it("applies currentlyLate from a separate late groupBy", () => {
    const buckets = mergeWingStatusGroups([
      { wingCode: "W1", status: ComplaintStatus.OPEN, count: 5 },
    ]);
    applyWingLateGroups(buckets, [{ wingCode: "W1", count: 2 }]);
    expect(buckets.get("W1")!.currentlyLate).toBe(2);
  });

  it("picks top classification by count then Arabic name then id", () => {
    const result = pickTopClassification({
      classificationCounts: new Map([
        ["cls-b", 2],
        ["cls-a", 2],
        ["cls-c", 1],
      ]),
      namesById: new Map([
        ["cls-b", "سلوك"],
        ["cls-a", "مواعيد"],
        ["cls-c", "أخرى"],
      ]),
    });
    expect(result).toEqual({ topClassification: "سلوك", topClassificationCount: 2 });
  });

  it("returns null top classification when none exist", () => {
    expect(
      pickTopClassification({
        classificationCounts: new Map(),
        namesById: new Map(),
      })
    ).toEqual({ topClassification: null, topClassificationCount: 0 });
  });

  it("excludes unspecified from items, sorts, and caps at 40", () => {
    const buckets = new Map<
      string,
      {
        key: string;
        count: number;
        open: number;
        closed: number;
        currentlyLate: number;
        classificationCounts: Map<string, number>;
      }
    >();
    for (let index = 0; index < 45; index += 1) {
      const key = `W${String(index + 1).padStart(2, "0")}`;
      buckets.set(key, {
        key,
        count: 45 - index,
        open: 1,
        closed: 44 - index,
        currentlyLate: 0,
        classificationCounts: new Map(),
      });
    }
    buckets.set(OPERATIONAL_UNSPECIFIED, {
      key: OPERATIONAL_UNSPECIFIED,
      count: 9,
      open: 9,
      closed: 0,
      currentlyLate: 0,
      classificationCounts: new Map(),
    });

    const metrics = buildWingMetricsFromAggregates({
      buckets,
      namesById: new Map(),
      total: 1000,
    });
    expect(metrics.items).toHaveLength(40);
    expect(metrics.items[0]?.key).toBe("W01");
    expect(metrics.unspecifiedCount).toBe(9);
    expect(metrics.items.every((item) => item.key !== OPERATIONAL_UNSPECIFIED)).toBe(true);
  });

  it("returns zero percentages when total is 0", () => {
    const buckets = mergeWingStatusGroups([
      { wingCode: "W1", status: ComplaintStatus.OPEN, count: 2 },
    ]);
    const metrics = buildWingMetricsFromAggregates({
      buckets,
      namesById: new Map(),
      total: 0,
    });
    expect(metrics.items[0]?.percentage).toBe(0);
  });

  it("does not mutate input classification count maps when picking tops", () => {
    const classificationCounts = new Map([["cls-a", 3]]);
    const snapshot = new Map(classificationCounts);
    pickTopClassification({
      classificationCounts,
      namesById: new Map([["cls-a", "مواعيد"]]),
    });
    expect(classificationCounts).toEqual(snapshot);
  });
});

describe("wing aggregate vs reference parity", () => {
  it("matches full WingOperationalMetrics for the fixed dataset", () => {
    const rows = createParityDataset();
    const total = rows.length;
    const expected = referenceBuildWingMetrics(rows, NOW, total);
    const { buckets, namesById } = aggregatesFromRows(rows, NOW);
    const actual = buildWingMetricsFromAggregates({ buckets, namesById, total });
    expect(actual).toEqual(expected);
  });
});

describe("loadWingOperationalMetrics query shape", () => {
  beforeEach(() => {
    dbMocks.findMany.mockReset();
    dbMocks.groupBy.mockReset();
    dbMocks.classificationFindMany.mockReset();
  });

  it("uses fixed groupBy queries and at most one classification findMany without take/N+1", async () => {
    dbMocks.groupBy.mockImplementation(async (args: { by: string[] }) => {
      if (args.by.includes("status")) {
        return [
          { wingCode: "W1", status: ComplaintStatus.OPEN, _count: { _all: 2 } },
          { wingCode: "W1", status: ComplaintStatus.CLOSED, _count: { _all: 1 } },
          { wingCode: null, status: ComplaintStatus.NEW, _count: { _all: 1 } },
        ];
      }
      if (args.by.length === 1 && args.by[0] === "wingCode") {
        return [{ wingCode: "W1", _count: { _all: 1 } }];
      }
      return [
        { wingCode: "W1", classificationId: "cls-a", _count: { _all: 2 } },
        { wingCode: "W1", classificationId: null, _count: { _all: 1 } },
      ];
    });
    dbMocks.classificationFindMany.mockResolvedValue([{ id: "cls-a", nameAr: "مواعيد" }]);

    const result = await loadWingOperationalMetrics({
      where: { isDeleted: false },
      now: NOW,
      total: 4,
    });

    expect(result.metrics.items).toEqual([
      {
        key: "W1",
        label: "W1",
        count: 3,
        percentage: 75,
        open: 2,
        closed: 1,
        currentlyLate: 1,
        topClassification: "مواعيد",
        topClassificationCount: 2,
        drillDownFilters: { wingCode: "W1" },
      },
    ]);
    expect(result.metrics.unspecifiedCount).toBe(1);

    expect(dbMocks.groupBy).toHaveBeenCalledTimes(3);
    expect(dbMocks.classificationFindMany).toHaveBeenCalledTimes(1);
    expect(dbMocks.classificationFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["cls-a"] } },
      select: { id: true, nameAr: true },
    });

    for (const call of dbMocks.groupBy.mock.calls) {
      expect(call[0]).not.toHaveProperty("take");
      expect(call[0]).not.toHaveProperty("skip");
    }
    expect(dbMocks.findMany).not.toHaveBeenCalled();
  });

  it("skips classification findMany when every classificationId is null", async () => {
    dbMocks.groupBy.mockImplementation(async (args: { by: string[] }) => {
      if (args.by.includes("status")) {
        return [{ wingCode: "W2", status: ComplaintStatus.CLOSED, _count: { _all: 1 } }];
      }
      if (args.by.includes("classificationId")) {
        return [{ wingCode: "W2", classificationId: null, _count: { _all: 1 } }];
      }
      return [];
    });

    const result = await loadWingOperationalMetrics({
      where: { isDeleted: false },
      now: NOW,
      total: 1,
    });

    expect(result.metrics.items[0]).toMatchObject({
      key: "W2",
      topClassification: null,
      topClassificationCount: 0,
    });
    expect(dbMocks.classificationFindMany).not.toHaveBeenCalled();
  });
});
