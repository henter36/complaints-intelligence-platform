import { describe, expect, it, vi, beforeEach } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import {
  buildComplaintWhere,
  parseComplaintQuery,
} from "@/server/complaints/complaint-query-service";
import {
  buildFreshness,
  formatInstantInRiyadh,
  getOperationalAnalytics,
  normalizeActionTakenKey,
  resolveFreshnessBucket,
} from "@/server/analytics/operational/operational-analytics-service";
import {
  DATA_FRESHNESS_BUCKETS,
  OPERATIONAL_UNSPECIFIED,
} from "@/server/analytics/operational/operational-analytics-types";
import {
  matchesFreshnessBucketWhere,
  freshnessBucketWhere,
} from "@/server/analytics/operational/operational-freshness";
import {
  detectOperationalTextPatterns,
  iterTextSignalSources,
} from "@/server/analytics/operational/operational-text-signals";
import { REPORT_DEFINITIONS } from "@/server/reports/report-definition-service";
import { ReportType } from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

function q(query: string) {
  return new URLSearchParams(query);
}

const FRESHNESS_NOW = new Date("2026-08-05T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function ago(ms: number): Date {
  return new Date(FRESHNESS_NOW.getTime() - ms);
}

/** Fixed fixture covering all required freshness cases for object-parity checks. */
function createFreshnessFixtureRows() {
  return [
    { sourceUpdatedAt: null, sourceModifiedAt: null },
    { sourceUpdatedAt: ago(12 * 60 * 60 * 1000), sourceModifiedAt: ago(13 * 60 * 60 * 1000) },
    { sourceUpdatedAt: ago(DAY_MS), sourceModifiedAt: ago(DAY_MS + 60 * 60 * 1000) },
    { sourceUpdatedAt: ago(2 * DAY_MS), sourceModifiedAt: ago(2 * DAY_MS - 2 * 60 * 60 * 1000) },
    { sourceUpdatedAt: ago(3 * DAY_MS), sourceModifiedAt: ago(4 * DAY_MS) },
    { sourceUpdatedAt: ago(5 * DAY_MS), sourceModifiedAt: ago(6 * DAY_MS) },
    { sourceUpdatedAt: ago(7 * DAY_MS), sourceModifiedAt: ago(8 * DAY_MS) },
    { sourceUpdatedAt: ago(10 * DAY_MS), sourceModifiedAt: ago(11 * DAY_MS) },
    { sourceUpdatedAt: ago(4 * DAY_MS), sourceModifiedAt: ago(4 * DAY_MS - 3 * 60 * 60 * 1000) },
    { sourceUpdatedAt: ago(6 * DAY_MS), sourceModifiedAt: ago(6 * DAY_MS + 5 * 60 * 60 * 1000) },
    { sourceUpdatedAt: null, sourceModifiedAt: ago(DAY_MS) },
    { sourceUpdatedAt: ago(20 * DAY_MS), sourceModifiedAt: ago(21 * DAY_MS) },
    { sourceUpdatedAt: ago(1 * 60 * 60 * 1000), sourceModifiedAt: ago(2 * 60 * 60 * 1000) },
  ];
}

const FRESHNESS_REFERENCE = {
  lastSourceUpdatedAt: "2026-08-05T11:00:00.000Z",
  lastSourceUpdatedAtRiyadh: formatInstantInRiyadh(new Date("2026-08-05T11:00:00.000Z")),
  oldestSourceUpdatedAt: "2026-07-16T12:00:00.000Z",
  oldestSourceUpdatedAtRiyadh: formatInstantInRiyadh(new Date("2026-07-16T12:00:00.000Z")),
  averageAgeDays: 5.3,
  freshShare: 15.4,
  staleShare: 69.2,
  buckets: [
    {
      bucket: "fresh_1d" as const,
      label: "خلال يوم",
      count: 2,
      percentage: 15.4,
      drillDownFilters: { dataFreshnessBucket: "fresh_1d" },
    },
    {
      bucket: "stale_1_3d" as const,
      label: "1–3 أيام",
      count: 2,
      percentage: 15.4,
      drillDownFilters: { dataFreshnessBucket: "stale_1_3d" },
    },
    {
      bucket: "stale_3_7d" as const,
      label: "3–7 أيام",
      count: 4,
      percentage: 30.8,
      drillDownFilters: { dataFreshnessBucket: "stale_3_7d" },
    },
    {
      bucket: "stale_7d_plus" as const,
      label: "أكثر من 7 أيام",
      count: 3,
      percentage: 23.1,
      drillDownFilters: { dataFreshnessBucket: "stale_7d_plus" },
    },
    {
      bucket: "missing" as const,
      label: "بلا تاريخ تحديث",
      count: 2,
      percentage: 15.4,
      drillDownFilters: { dataFreshnessBucket: "missing" },
    },
  ],
  missingUpdatedAt: 2,
  missingModifiedAt: 1,
  modifiedBeforeUpdated: 2,
  updatedVsModifiedDiffHoursAvg: 11.2,
};

describe("operational field semantic separation", () => {
  it("keeps sourceOrigin independent from channel", () => {
    const where = buildComplaintWhere(
      parseComplaintQuery(q("sourceOrigin=الجهاز الرئيسي&channel=الهاتف"))
    );
    expect(where.sourceOrigin).toBe("الجهاز الرئيسي");
    expect(where.channel).toBe("الهاتف");
  });

  it("keeps sourceStatus independent from status", () => {
    const where = buildComplaintWhere(
      parseComplaintQuery(q("sourceStatus=مغلقة&status=OPEN"))
    );
    expect(where.sourceStatus).toBe("مغلقة");
    expect(where.status).toBe(ComplaintStatus.OPEN);
  });

  it("keeps sourceActionStatus independent from status", () => {
    const where = buildComplaintWhere(
      parseComplaintQuery(q("sourceActionStatus=جديد&status=CLOSED"))
    );
    expect(where.sourceActionStatus).toBe("جديد");
    expect(where.status).toBe(ComplaintStatus.CLOSED);
  });

  it("applies hasActionTaken and hasResolution as independent presence filters", () => {
    const where = buildComplaintWhere(
      parseComplaintQuery(q("hasActionTaken=true&hasResolution=false"))
    );
    const serialized = JSON.stringify(where);
    expect(serialized).toContain("actionTaken");
    expect(serialized).toContain("resolution");
  });

  it("searches actionDescription separately from description", () => {
    const where = buildComplaintWhere(parseComplaintQuery(q("search=متابعة")));
    const or = (where.AND as Array<Record<string, unknown>>).find((clause) => Array.isArray(clause.OR));
    const fields = ((or?.OR as Array<Record<string, unknown>>) ?? []).flatMap((entry) =>
      Object.keys(entry)
    );
    expect(fields).toEqual(
      expect.arrayContaining(["description", "actionDescription", "sourceDetail"])
    );
  });

  it("filters wingCode including unspecified sentinel", () => {
    const specified = buildComplaintWhere(parseComplaintQuery(q("wingCode=3")));
    expect(specified.wingCode).toBe("3");

    const unspecified = buildComplaintWhere(
      parseComplaintQuery(q(`wingCode=${OPERATIONAL_UNSPECIFIED}`))
    );
    expect(JSON.stringify(unspecified)).toContain("wingCode");
    expect(JSON.stringify(unspecified)).toContain("null");
  });
});

describe("freshness buckets and Riyadh display", () => {
  const now = FRESHNESS_NOW;

  it("classifies freshness buckets at boundaries", () => {
    expect(resolveFreshnessBucket(null, now)).toBe("missing");
    expect(resolveFreshnessBucket(new Date(now.getTime() - 12 * 60 * 60 * 1000), now)).toBe("fresh_1d");
    expect(resolveFreshnessBucket(new Date(now.getTime() - DAY_MS), now)).toBe("stale_1_3d");
    expect(resolveFreshnessBucket(new Date(now.getTime() - 2 * DAY_MS), now)).toBe("stale_1_3d");
    expect(resolveFreshnessBucket(new Date(now.getTime() - 3 * DAY_MS), now)).toBe("stale_3_7d");
    expect(resolveFreshnessBucket(new Date(now.getTime() - 5 * DAY_MS), now)).toBe("stale_3_7d");
    expect(resolveFreshnessBucket(new Date(now.getTime() - 7 * DAY_MS), now)).toBe("stale_7d_plus");
    expect(resolveFreshnessBucket(new Date(now.getTime() - 10 * DAY_MS), now)).toBe("stale_7d_plus");
  });

  it("formats display timestamps in Asia/Riyadh without mutating storage", () => {
    const utc = new Date("2026-07-15T21:00:00.000Z");
    const formatted = formatInstantInRiyadh(utc);
    expect(formatted).toBeTruthy();
    expect(utc.toISOString()).toBe("2026-07-15T21:00:00.000Z");
  });

  it("normalizes actionTaken keys without writing a permanent dictionary", () => {
    expect(normalizeActionTakenKey("  تم  الإجراء  ")).toBe("تم الإجراء");
  });

  it("matches the frozen freshness reference object exactly after refactor", () => {
    const rows = createFreshnessFixtureRows();
    const inputSnapshots = rows.map((row) => ({
      sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
      sourceModifiedAt: row.sourceModifiedAt?.toISOString() ?? null,
    }));

    const actual = buildFreshness(rows, FRESHNESS_NOW);

    expect(actual).toEqual(FRESHNESS_REFERENCE);
    expect(DATA_FRESHNESS_BUCKETS).toEqual([
      "fresh_1d",
      "stale_1_3d",
      "stale_3_7d",
      "stale_7d_plus",
      "missing",
    ]);
    expect(actual.buckets.map((bucket) => bucket.bucket)).toEqual([...DATA_FRESHNESS_BUCKETS]);
    expect(actual.missingUpdatedAt).toBe(2);
    expect(actual.missingModifiedAt).toBe(1);
    expect(actual.modifiedBeforeUpdated).toBe(2);
    expect(actual.averageAgeDays).toBe(5.3);
    expect(actual.updatedVsModifiedDiffHoursAvg).toBe(11.2);
    expect(actual.lastSourceUpdatedAt).toBe("2026-08-05T11:00:00.000Z");
    expect(actual.oldestSourceUpdatedAt).toBe("2026-07-16T12:00:00.000Z");
    expect(actual.lastSourceUpdatedAtRiyadh).toBe(
      formatInstantInRiyadh(new Date("2026-08-05T11:00:00.000Z"))
    );
    expect(actual.oldestSourceUpdatedAtRiyadh).toBe(
      formatInstantInRiyadh(new Date("2026-07-16T12:00:00.000Z"))
    );

    expect(
      rows.map((row) => ({
        sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
        sourceModifiedAt: row.sourceModifiedAt?.toISOString() ?? null,
      }))
    ).toEqual(inputSnapshots);
  });

  it("keeps resolveFreshnessBucket and drill-down where in object parity", () => {
    const samples: Array<Date | null> = [
      new Date(now.getTime() + 60 * 60 * 1000),
      now,
      new Date(now.getTime() - (DAY_MS - 1000)),
      new Date(now.getTime() - DAY_MS),
      new Date(now.getTime() - 2 * DAY_MS),
      new Date(now.getTime() - 3 * DAY_MS),
      new Date(now.getTime() - 6 * DAY_MS),
      new Date(now.getTime() - 7 * DAY_MS),
      new Date(now.getTime() - 8 * DAY_MS),
      null,
    ];

    for (const sample of samples) {
      const bucket = resolveFreshnessBucket(sample, now);
      expect(matchesFreshnessBucketWhere(sample, bucket, now)).toBe(true);

      for (const other of DATA_FRESHNESS_BUCKETS) {
        if (other === bucket) continue;
        expect(matchesFreshnessBucketWhere(sample, other, now)).toBe(false);
      }

      const where = buildComplaintWhere(
        parseComplaintQuery(new URLSearchParams({ dataFreshnessBucket: bucket })),
        now
      );
      const expected = freshnessBucketWhere(bucket, now);
      expect(where.AND).toEqual(expect.arrayContaining([expected]));
    }
  });

  it("matches metric bucket counts to drill-down membership", () => {
    const rows = createFreshnessFixtureRows();
    const metrics = buildFreshness(rows, now);
    for (const bucket of DATA_FRESHNESS_BUCKETS) {
      const metricCount = metrics.buckets.find((b) => b.bucket === bucket)?.count ?? -1;
      const drillDownCount = rows.filter((row) =>
        matchesFreshnessBucketWhere(row.sourceUpdatedAt, bucket, now)
      ).length;
      expect(drillDownCount).toBe(metricCount);
    }
  });
});

describe("operational text signal sources", () => {
  it("keeps description, sourceDetail, and actionDescription as separate sources", () => {
    const sources = iterTextSignalSources({
      description: "نص الشكوى",
      sourceDetail: "تفصيل مصدر",
      actionDescription: "وصف إجراء",
    });
    expect(sources.map((s) => s.source)).toEqual([
      "COMPLAINT_DESCRIPTION",
      "SOURCE_DETAIL",
      "ACTION_DESCRIPTION",
    ]);
  });

  it("labels pattern findings with their text source", () => {
    const findings = detectOperationalTextPatterns({
      description: "لم يتم اتخاذ إجراء مناسب",
      sourceDetail: null,
      actionDescription: "جار العمل على الطلب",
    });
    expect(findings.some((f) => f.source === "COMPLAINT_DESCRIPTION" && f.code === "NO_ACTION")).toBe(
      true
    );
    expect(
      findings.some((f) => f.source === "ACTION_DESCRIPTION" && f.code === "INCOMPLETE_ACTION")
    ).toBe(true);
  });

  it("does not flag ordinary closures as CLOSURE_WITHOUT_TREATMENT", () => {
    const negatives = [
      "أُغلق الطلب بعد المعالجة.",
      "تم الإغلاق بعد تنفيذ الإجراء.",
      "أغلق المستخدم الشكوى بعد حلها.",
      "تاريخ الإغلاق مسجل.",
    ];
    for (const text of negatives) {
      const findings = detectOperationalTextPatterns({
        description: text,
        sourceDetail: null,
        actionDescription: null,
      });
      expect(findings.some((f) => f.code === "CLOSURE_WITHOUT_TREATMENT")).toBe(false);
    }
  });

  it("flags closure without treatment and administrative closure", () => {
    const positives = [
      "تم الإغلاق دون معالجة.",
      "أُغلق دون إجراء.",
      "إغلاق إداري.",
      "تم الاغلاق دون حل.",
      "تـــم الإغــلاق دون مُعالجة",
    ];
    for (const text of positives) {
      const findings = detectOperationalTextPatterns({
        description: text,
        sourceDetail: null,
        actionDescription: null,
      });
      expect(findings.some((f) => f.code === "CLOSURE_WITHOUT_TREATMENT")).toBe(true);
      expect(findings.find((f) => f.code === "CLOSURE_WITHOUT_TREATMENT")?.label).toBe(
        "إغلاق دون معالجة واضحة"
      );
    }
  });
});

describe("staff actor privacy gating", () => {
  beforeEach(() => {
    dbMocks.findMany.mockReset();
    dbMocks.groupBy.mockReset();
    dbMocks.count.mockReset();
    dbMocks.groupBy.mockResolvedValue([]);
    dbMocks.count.mockResolvedValue(1);
  });

  function staffRow() {
    return {
      id: "c1",
      status: ComplaintStatus.CLOSED,
      channel: "الهاتف",
      sourceOrigin: "منصة",
      sourceStatus: "مغلقة",
      sourceActionStatus: "منتهية",
      wingCode: "1",
      actionTaken: "تم",
      actionDescription: null,
      resolution: "حل",
      sourceUpdatedAt: FRESHNESS_NOW,
      sourceModifiedAt: FRESHNESS_NOW,
      sourceClosedBy: "AhmedAli",
      sourceUpdatedBy: "SaraNasser",
      complaintDate: FRESHNESS_NOW,
      receivedAt: FRESHNESS_NOW,
      dueDate: null,
      closedAt: FRESHNESS_NOW,
      classification: { nameAr: "مواعيد" },
    };
  }

  it("ignores includeStaffActors query param when options are false", async () => {
    dbMocks.findMany.mockResolvedValue([staffRow()]);
    const summary = await getOperationalAnalytics(
      new URLSearchParams("includeStaffActors=true"),
      { includeStaffActors: false, now: FRESHNESS_NOW }
    );
    expect(summary.staffActors.enabled).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("AhmedAli");
    expect(JSON.stringify(summary)).not.toContain("SaraNasser");
  });

  it("keeps staff disabled when query param is true without options", async () => {
    dbMocks.findMany.mockResolvedValue([staffRow()]);
    const summary = await getOperationalAnalytics(
      new URLSearchParams("includeStaffActors=true"),
      { now: FRESHNESS_NOW }
    );
    expect(summary.staffActors.enabled).toBe(false);
  });

  it("enables masked staff metrics only when options.includeStaffActors is true", async () => {
    dbMocks.findMany.mockResolvedValue([staffRow()]);
    const summary = await getOperationalAnalytics(new URLSearchParams(), {
      includeStaffActors: true,
      now: FRESHNESS_NOW,
    });
    expect(summary.staffActors.enabled).toBe(true);
    if (summary.staffActors.enabled) {
      expect(summary.staffActors.closers?.[0]?.maskedId).toMatch(/^A\*\*\*i$/);
      expect(summary.staffActors.updaters?.[0]?.maskedId).toMatch(/^S\*\*\*r$/);
    }
    expect(JSON.stringify(summary)).not.toContain("AhmedAli");
    expect(JSON.stringify(summary)).not.toContain("SaraNasser");
  });
});

describe("reports and export regression — operational fields excluded", () => {
  const forbidden = [
    "sourceOrigin",
    "sourceStatus",
    "sourceActionStatus",
    "sourceDetail",
    "sourceClosedBy",
    "actionTaken",
    "actionDescription",
    "wingCode",
    "sourceUpdatedAt",
    "sourceModifiedAt",
    "sourceUpdatedBy",
  ];

  it("does not add operational fields to report default columns or filters", () => {
    for (const definition of Object.values(REPORT_DEFINITIONS)) {
      for (const field of forbidden) {
        expect(definition.defaultColumns).not.toContain(field);
        expect(definition.supportedFilters).not.toContain(field);
      }
    }
    expect(REPORT_DEFINITIONS[ReportType.COMPLAINT_DETAIL].defaultColumns).toContain("channel");
  });

  it("does not add operational fields to CSV export rows", () => {
    const exportSource = readFileSync(
      resolve(process.cwd(), "src/app/api/complaints/export/route.ts"),
      "utf8"
    );
    for (const field of forbidden) {
      expect(exportSource).not.toContain(`item.${field}`);
    }
    expect(exportSource).toContain("item.channel");
  });
});
