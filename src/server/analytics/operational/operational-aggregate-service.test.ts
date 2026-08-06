import { describe, expect, it, vi, beforeEach } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import {
  buildBucketMetricsFromAggregates,
  buildResolutionAverageByDimensions,
  categoricalKey,
  categoricalLabel,
  countDistinctCategoricalKeys,
  mergeLateGroupsIntoAggregates,
  mergeStatusGroupsIntoAggregates,
  resolutionDaysFromDates,
  loadAggregatedOperationalDimensions,
  type AggregateDimensionRow,
} from "./operational-aggregate-service";
import {
  OPERATIONAL_UNSPECIFIED,
  OPERATIONAL_UNSPECIFIED_LABEL,
} from "./operational-analytics-types";
import { buildComplaintTiming } from "@/server/complaints/complaint-timing";
import {
  CLOSED_COMPLAINT_STATUSES,
  OPEN_COMPLAINT_STATUSES,
} from "@/server/complaints/status";

const dbMocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  groupBy: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      findMany: dbMocks.findMany,
      groupBy: dbMocks.groupBy,
      count: dbMocks.count,
    },
  },
}));

const NOW = new Date("2026-08-05T12:00:00.000Z");

type ReferenceRow = {
  status: ComplaintStatus;
  sourceOrigin: string | null;
  sourceStatus: string | null;
  sourceActionStatus: string | null;
  channel: string | null;
  complaintDate: Date | null;
  receivedAt: Date;
  dueDate: Date | null;
  closedAt: Date | null;
};

/** Legacy in-memory bucket builder kept as the numeric reference for parity. */
function referenceBucketMetrics(
  rows: ReferenceRow[],
  now: Date,
  keyFn: (row: ReferenceRow) => string,
  filterKey: string,
  previousByKey: Map<string, number> | null,
  total: number
) {
  const groups = new Map<string, ReferenceRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([key, items]) => {
      let open = 0;
      let closed = 0;
      let currentlyLate = 0;
      let resolutionSum = 0;
      let resolutionN = 0;
      for (const item of items) {
        if (OPEN_COMPLAINT_STATUSES.has(item.status)) open += 1;
        if (CLOSED_COMPLAINT_STATUSES.has(item.status)) closed += 1;
        const timing = buildComplaintTiming(item, now);
        if (timing.isCurrentlyLate) currentlyLate += 1;
        if (timing.resolutionDays != null) {
          resolutionSum += timing.resolutionDays;
          resolutionN += 1;
        }
      }
      const previousCount = previousByKey?.get(key) ?? null;
      const count = items.length;
      return {
        key,
        label: categoricalLabel(key),
        count,
        percentage: total <= 0 ? 0 : Math.round((count / total) * 1000) / 10,
        open,
        closed,
        currentlyLate,
        averageResolutionDays:
          resolutionN > 0 ? Math.round((resolutionSum / resolutionN) * 10) / 10 : null,
        previousCount,
        change: previousCount == null ? null : count - previousCount,
        drillDownFilters: { [filterKey]: key },
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ar"));
}

function aggregatesFromRows(
  rows: ReferenceRow[],
  field: "sourceOrigin" | "sourceStatus" | "sourceActionStatus",
  now: Date
): Map<string, AggregateDimensionRow> {
  const statusGroups: Array<{
    dimensionValue: string | null;
    status: ComplaintStatus;
    count: number;
  }> = [];
  const statusIndex = new Map<string, number>();
  for (const row of rows) {
    const raw = row[field];
    const indexKey = `${raw === null ? "__null__" : JSON.stringify(raw)}|${row.status}`;
    const existing = statusIndex.get(indexKey);
    if (existing != null) {
      statusGroups[existing]!.count += 1;
      continue;
    }
    statusIndex.set(indexKey, statusGroups.length);
    statusGroups.push({ dimensionValue: raw, status: row.status, count: 1 });
  }
  const merged = mergeStatusGroupsIntoAggregates(statusGroups);
  const lateByRaw = new Map<string | null, number>();
  for (const row of rows) {
    if (!buildComplaintTiming(row, now).isCurrentlyLate) continue;
    lateByRaw.set(row[field], (lateByRaw.get(row[field]) ?? 0) + 1);
  }
  const lateGroups = Array.from(lateByRaw.entries()).map(([dimensionValue, count]) => ({
    dimensionValue,
    count,
  }));
  return mergeLateGroupsIntoAggregates(merged, lateGroups);
}

function createParityDataset(): ReferenceRow[] {
  const receivedAt = new Date("2026-07-01T08:00:00.000Z");
  return [
    {
      status: ComplaintStatus.OPEN,
      sourceOrigin: "الجهاز الرئيسي",
      sourceStatus: "مبدئي",
      sourceActionStatus: "جديد",
      channel: "الهاتف",
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      receivedAt,
      dueDate: new Date("2026-07-10T00:00:00.000Z"),
      closedAt: null,
    },
    {
      status: ComplaintStatus.IN_PROGRESS,
      sourceOrigin: "الجهاز الرئيسي",
      sourceStatus: "قيد المعالجة",
      sourceActionStatus: "قيد التنفيذ",
      channel: "المنصة",
      complaintDate: new Date("2026-06-01T00:00:00.000Z"),
      receivedAt,
      dueDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: null,
    },
    {
      status: ComplaintStatus.CLOSED,
      sourceOrigin: "منصة إلكترونية",
      sourceStatus: "مغلقة",
      sourceActionStatus: "منتهية",
      channel: "الهاتف",
      complaintDate: new Date("2026-06-20T00:00:00.000Z"),
      receivedAt,
      dueDate: null,
      closedAt: new Date("2026-06-25T00:00:00.000Z"),
    },
    {
      status: ComplaintStatus.RESOLVED,
      sourceOrigin: "منصة إلكترونية",
      sourceStatus: "مغلقة",
      sourceActionStatus: "منتهية",
      channel: "البريد",
      complaintDate: null,
      receivedAt: new Date("2026-06-10T00:00:00.000Z"),
      dueDate: null,
      closedAt: new Date("2026-06-12T00:00:00.000Z"),
    },
    {
      status: ComplaintStatus.OPEN,
      sourceOrigin: null,
      sourceStatus: null,
      sourceActionStatus: null,
      channel: null,
      complaintDate: receivedAt,
      receivedAt,
      dueDate: new Date("2026-08-20T00:00:00.000Z"),
      closedAt: null,
    },
    {
      status: ComplaintStatus.NEW,
      sourceOrigin: "",
      sourceStatus: "   ",
      sourceActionStatus: "",
      channel: "",
      complaintDate: receivedAt,
      receivedAt,
      dueDate: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: null,
    },
    {
      status: ComplaintStatus.CLOSED,
      sourceOrigin: "الجهاز الرئيسي",
      sourceStatus: "مغلقة",
      sourceActionStatus: "جديد",
      channel: "الهاتف",
      complaintDate: new Date("2026-07-05T00:00:00.000Z"),
      receivedAt,
      dueDate: new Date("2026-07-08T00:00:00.000Z"),
      closedAt: new Date("2026-07-04T00:00:00.000Z"),
    },
    {
      status: ComplaintStatus.CLOSED,
      sourceOrigin: "منصة إلكترونية",
      sourceStatus: "مغلقة",
      sourceActionStatus: "منتهية",
      channel: "المنصة",
      complaintDate: new Date("2026-05-01T00:00:00.000Z"),
      receivedAt,
      dueDate: null,
      closedAt: new Date("2026-05-20T00:00:00.000Z"),
    },
  ];
}

describe("operational aggregate helpers", () => {
  it("merges null and empty string into unspecified", () => {
    const map = mergeStatusGroupsIntoAggregates([
      { dimensionValue: null, status: ComplaintStatus.OPEN, count: 2 },
      { dimensionValue: "", status: ComplaintStatus.CLOSED, count: 3 },
      { dimensionValue: "  ", status: ComplaintStatus.NEW, count: 1 },
    ]);
    const row = map.get(OPERATIONAL_UNSPECIFIED)!;
    expect(row.count).toBe(6);
    expect(row.open).toBe(3);
    expect(row.closed).toBe(3);
  });

  it("sums open and closed across multiple statuses for the same key", () => {
    const map = mergeStatusGroupsIntoAggregates([
      { dimensionValue: "أ", status: ComplaintStatus.OPEN, count: 2 },
      { dimensionValue: "أ", status: ComplaintStatus.IN_PROGRESS, count: 1 },
      { dimensionValue: "أ", status: ComplaintStatus.CLOSED, count: 4 },
      { dimensionValue: "أ", status: ComplaintStatus.RESOLVED, count: 1 },
    ]);
    const row = map.get("أ")!;
    expect(row.count).toBe(8);
    expect(row.open).toBe(3);
    expect(row.closed).toBe(5);
  });

  it("applies currentlyLate from a separate late groupBy", () => {
    const base = mergeStatusGroupsIntoAggregates([
      { dimensionValue: "أ", status: ComplaintStatus.OPEN, count: 5 },
    ]);
    mergeLateGroupsIntoAggregates(base, [{ dimensionValue: "أ", count: 2 }]);
    expect(base.get("أ")!.currentlyLate).toBe(2);
  });

  it("computes resolution days with complaintDate fallback and floor at zero", () => {
    const receivedAt = new Date("2026-07-10T00:00:00.000Z");
    const closedAt = new Date("2026-07-12T00:00:00.000Z");
    expect(resolutionDaysFromDates(null, receivedAt, closedAt)).toBe(2);
    expect(
      resolutionDaysFromDates(
        new Date("2026-07-15T00:00:00.000Z"),
        receivedAt,
        closedAt
      )
    ).toBe(0);
  });

  it("builds resolution averages for all three dimensions in one pass", () => {
    const averages = buildResolutionAverageByDimensions([
      {
        sourceOrigin: "أ",
        sourceStatus: null,
        sourceActionStatus: "",
        complaintDate: new Date("2026-07-01T00:00:00.000Z"),
        receivedAt: new Date("2026-07-01T00:00:00.000Z"),
        closedAt: new Date("2026-07-03T00:00:00.000Z"),
      },
      {
        sourceOrigin: "أ",
        sourceStatus: "مغلقة",
        sourceActionStatus: "منتهية",
        complaintDate: null,
        receivedAt: new Date("2026-07-01T00:00:00.000Z"),
        closedAt: new Date("2026-07-11T00:00:00.000Z"),
      },
    ]);
    expect(averages.sourceOrigin.get("أ")).toBe(6);
    expect(averages.sourceStatus.get(OPERATIONAL_UNSPECIFIED)).toBe(2);
    expect(averages.sourceActionStatus.get(OPERATIONAL_UNSPECIFIED)).toBe(2);
  });

  it("builds bucket metrics with percentage, change, sorting, and zero total", () => {
    const dimensionRows = new Map<string, AggregateDimensionRow>([
      ["ب", { key: "ب", count: 5, open: 2, closed: 3, currentlyLate: 1 }],
      ["أ", { key: "أ", count: 5, open: 1, closed: 4, currentlyLate: 0 }],
      ["ج", { key: "ج", count: 1, open: 1, closed: 0, currentlyLate: 0 }],
    ]);
    const previous = new Map([["ب", 2]]);
    const buckets = buildBucketMetricsFromAggregates({
      dimensionRows,
      resolutionAverageByKey: new Map([["ب", 3.5]]),
      previousByKey: previous,
      filterKey: "sourceOrigin",
      total: 11,
    });
    expect(buckets[0]!.key).toBe("أ");
    expect(buckets[1]!.key).toBe("ب");
    expect(buckets[1]!.previousCount).toBe(2);
    expect(buckets[1]!.change).toBe(3);
    expect(buckets[1]!.percentage).toBe(45.5);
    expect(buckets[1]!.averageResolutionDays).toBe(3.5);
    expect(buckets[2]!.previousCount).toBeNull();
    expect(buckets[2]!.change).toBeNull();

    const empty = buildBucketMetricsFromAggregates({
      dimensionRows,
      resolutionAverageByKey: new Map(),
      previousByKey: null,
      filterKey: "sourceStatus",
      total: 0,
    });
    expect(empty.every((b) => b.percentage === 0)).toBe(true);
  });

  it("does not mutate input aggregate maps when building late merges from copies", () => {
    const input: AggregateDimensionRow = {
      key: "أ",
      count: 1,
      open: 1,
      closed: 0,
      currentlyLate: 0,
    };
    const map = new Map([["أ", { ...input }]]);
    const snapshot = structuredClone(input);
    mergeLateGroupsIntoAggregates(map, [{ dimensionValue: "أ", count: 1 }]);
    expect(input).toEqual(snapshot);
    expect(map.get("أ")!.currentlyLate).toBe(1);
  });

  it("trims non-empty spaced values while collapsing whitespace-only to unspecified", () => {
    expect(categoricalKey("  منصة  ")).toBe("منصة");
    expect(categoricalKey("   ")).toBe(OPERATIONAL_UNSPECIFIED);
    expect(categoricalLabel(OPERATIONAL_UNSPECIFIED)).toBe(OPERATIONAL_UNSPECIFIED_LABEL);
  });

  it("counts distinct categorical keys including channel null/empty merge", () => {
    expect(countDistinctCategoricalKeys([null, "", "الهاتف", "الهاتف", "البريد"])).toBe(3);
  });
});

describe("aggregate vs reference parity", () => {
  it("matches sourceOrigin, sourceStatus, and sourceActionStatus fully", () => {
    const rows = createParityDataset();
    const total = rows.length;
    const previousByOrigin = new Map([
      ["الجهاز الرئيسي", 4],
      [OPERATIONAL_UNSPECIFIED, 1],
    ]);

    const resolutionAverages = buildResolutionAverageByDimensions(
      rows
        .filter((row) => row.closedAt != null)
        .map((row) => ({
          sourceOrigin: row.sourceOrigin,
          sourceStatus: row.sourceStatus,
          sourceActionStatus: row.sourceActionStatus,
          complaintDate: row.complaintDate,
          receivedAt: row.receivedAt,
          closedAt: row.closedAt!,
        }))
    );

    for (const field of ["sourceOrigin", "sourceStatus", "sourceActionStatus"] as const) {
      const aggregates = aggregatesFromRows(rows, field, NOW);
      const previous = field === "sourceOrigin" ? previousByOrigin : null;
      const actual = buildBucketMetricsFromAggregates({
        dimensionRows: aggregates,
        resolutionAverageByKey: resolutionAverages[field],
        previousByKey: previous,
        filterKey: field,
        total,
      });
      const expected = referenceBucketMetrics(
        rows,
        NOW,
        (row) => categoricalKey(row[field]),
        field,
        previous,
        total
      );
      expect(actual).toEqual(expected);
    }
  });

  it("keeps channel independence from sourceOrigin", () => {
    const rows = createParityDataset();
    const originKeys = countDistinctCategoricalKeys(rows.map((r) => r.sourceOrigin));
    const channelKeys = countDistinctCategoricalKeys(rows.map((r) => r.channel));
    expect(originKeys).toBeGreaterThan(0);
    expect(channelKeys).toBeGreaterThan(0);
    expect(originKeys).not.toBe(channelKeys);
  });
});

describe("loadAggregatedOperationalDimensions query shape", () => {
  beforeEach(() => {
    dbMocks.findMany.mockReset();
    dbMocks.groupBy.mockReset();
    dbMocks.count.mockReset();
    dbMocks.count.mockResolvedValue(8);
    dbMocks.findMany.mockResolvedValue([]);
    dbMocks.groupBy.mockImplementation(async (args: { by: string[] }) => {
      if (args.by.includes("status")) {
        return [
          {
            sourceOrigin: "أ",
            sourceStatus: "مبدئي",
            sourceActionStatus: "جديد",
            status: ComplaintStatus.OPEN,
            _count: { _all: 3 },
          },
        ];
      }
      if (args.by.length === 1 && args.by[0] === "channel") {
        return [{ channel: "الهاتف", _count: { _all: 3 } }];
      }
      if (args.by.length === 1 && args.by[0] === "sourceOrigin") {
        return [{ sourceOrigin: "أ", _count: { _all: 3 } }];
      }
      return [{ sourceOrigin: "أ", sourceStatus: "مبدئي", sourceActionStatus: "جديد", _count: { _all: 1 } }];
    });
  });

  it("uses count + groupBy without take and without N+1 per bucket", async () => {
    const result = await loadAggregatedOperationalDimensions({
      where: { isDeleted: false },
      previousWhere: { isDeleted: false },
      now: NOW,
    });

    expect(result.totalInScope).toBe(8);
    expect(dbMocks.count).toHaveBeenCalledTimes(1);
    expect(dbMocks.findMany).toHaveBeenCalledTimes(1);
    const resolutionArgs = dbMocks.findMany.mock.calls[0]![0] as {
      select: Record<string, unknown>;
      take?: number;
    };
    expect(resolutionArgs.take).toBeUndefined();
    expect(resolutionArgs.select).toEqual({
      sourceOrigin: true,
      sourceStatus: true,
      sourceActionStatus: true,
      complaintDate: true,
      receivedAt: true,
      closedAt: true,
    });
    expect(resolutionArgs.select).not.toHaveProperty("description");
    expect(resolutionArgs.select).not.toHaveProperty("sourceDetail");
    expect(resolutionArgs.select).not.toHaveProperty("actionDescription");

    for (const call of dbMocks.groupBy.mock.calls) {
      expect(call[0]).not.toHaveProperty("take");
      expect(call[0]).not.toHaveProperty("skip");
    }

    const statusGroupCalls = dbMocks.groupBy.mock.calls.filter(
      (call) => Array.isArray(call[0]?.by) && call[0].by.includes("status")
    );
    expect(statusGroupCalls).toHaveLength(3);

    const lateCalls = dbMocks.groupBy.mock.calls.filter((call) => {
      const where = call[0]?.where as { AND?: unknown[] } | undefined;
      return Array.isArray(where?.AND) && where.AND.length === 2;
    });
    expect(lateCalls).toHaveLength(3);
  });
});

describe("drill-down filter contract", () => {
  it("emits the same categorical key used by complaint list unspecified filters", () => {
    const buckets = buildBucketMetricsFromAggregates({
      dimensionRows: new Map([
        [
          OPERATIONAL_UNSPECIFIED,
          { key: OPERATIONAL_UNSPECIFIED, count: 2, open: 2, closed: 0, currentlyLate: 0 },
        ],
        ["الجهاز الرئيسي", { key: "الجهاز الرئيسي", count: 3, open: 1, closed: 2, currentlyLate: 1 }],
      ]),
      resolutionAverageByKey: new Map(),
      previousByKey: null,
      filterKey: "sourceOrigin",
      total: 5,
    });
    for (const bucket of buckets) {
      expect(bucket.drillDownFilters).toEqual({ sourceOrigin: bucket.key });
      expect(bucket.count).toBeGreaterThan(0);
    }
  });
});
