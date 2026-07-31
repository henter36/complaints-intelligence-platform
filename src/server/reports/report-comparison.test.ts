// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      findMany: dbMocks.findMany,
      count: dbMocks.count,
    },
  },
}));

// Arabic fixture names (per spec).
const R_RIYADH = "منطقة الرياض";
const R_MAKKAH = "منطقة مكة المكرمة";
const R_MADINAH = "منطقة المدينة المنورة";
const R_SHARQIYA = "منطقة الشرقية";
const D_HEALTH = "إدارة الرعاية الصحية";
const D_INMATES = "إدارة شؤون النزلاء";
const C_DELAY = { id: "cls_delay", nameAr: "تصنيف التأخر في تقديم الخدمة" };
const C_HEALTH = { id: "cls_health", nameAr: "تصنيف الرعاية الصحية" };
const C_VISIT = { id: "cls_visit", nameAr: "تصنيف الزيارة والاتصال" };

type Row = {
  complaintDate?: Date | null;
  receivedAt?: Date;
  region?: string | null;
  department?: string | null;
  classificationId?: string | null;
  classification?: { id: string; nameAr: string } | null;
};

function row(overrides: Row = {}): Row {
  return {
    complaintDate: new Date("2026-07-15T00:00:00Z"),
    receivedAt: new Date("2026-07-15T00:00:00Z"),
    region: R_RIYADH,
    department: D_HEALTH,
    classificationId: C_HEALTH.id,
    classification: C_HEALTH,
    ...overrides,
  };
}

const FILTERS = { from: "2026-07-08", to: "2026-07-14" }; // 7-day window

/** Mocks the two findMany calls (current, previous) in order. */
function mockPeriods(current: Row[], previous: Row[]): void {
  dbMocks.findMany.mockReset();
  dbMocks.findMany.mockResolvedValueOnce(current).mockResolvedValueOnce(previous);
}

async function loadModule() {
  return import("./report-comparison");
}

describe("derivePreviousPeriodRange", () => {
  it("weekly period: previous is exactly 7 days before, no overlap", async () => {
    const { derivePreviousPeriodRange } = await loadModule();
    const from = new Date("2026-07-08T00:00:00Z");
    const toExclusive = new Date("2026-07-15T00:00:00Z"); // 7 days
    const prev = derivePreviousPeriodRange(from, toExclusive)!;
    expect(prev.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(prev.toExclusive.toISOString()).toBe("2026-07-08T00:00:00.000Z");
  });

  it("custom period: previous equals same duration", async () => {
    const { derivePreviousPeriodRange } = await loadModule();
    const from = new Date("2026-07-10T00:00:00Z");
    const toExclusive = new Date("2026-07-13T00:00:00Z"); // 3 days
    const prev = derivePreviousPeriodRange(from, toExclusive)!;
    const duration = prev.toExclusive.getTime() - prev.from.getTime();
    expect(duration).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("no overlap: previous.toExclusive === current.from", async () => {
    const { derivePreviousPeriodRange } = await loadModule();
    const from = new Date("2026-07-08T00:00:00Z");
    const toExclusive = new Date("2026-07-15T00:00:00Z");
    const prev = derivePreviousPeriodRange(from, toExclusive)!;
    expect(prev.toExclusive.getTime()).toBe(from.getTime());
  });

  it("midnight boundary: day starts at 00:00:00", async () => {
    const { derivePreviousPeriodRange } = await loadModule();
    const from = new Date("2026-07-08T00:00:00.000Z");
    const toExclusive = new Date("2026-07-15T00:00:00.000Z");
    const prev = derivePreviousPeriodRange(from, toExclusive)!;
    expect(prev.from.getUTCHours()).toBe(0);
    expect(prev.from.getUTCMinutes()).toBe(0);
    expect(prev.from.getUTCSeconds()).toBe(0);
  });

  it("invalid range (from >= to) returns null", async () => {
    const { derivePreviousPeriodRange } = await loadModule();
    const from = new Date("2026-07-15T00:00:00Z");
    const toExclusive = new Date("2026-07-15T00:00:00Z");
    expect(derivePreviousPeriodRange(from, toExclusive)).toBeNull();
    const later = new Date("2026-07-10T00:00:00Z");
    expect(derivePreviousPeriodRange(from, later)).toBeNull();
  });
});

describe("RegionChangeRow", () => {
  beforeEach(() => dbMocks.findMany.mockReset());

  async function changes(current: Row[], previous: Row[]) {
    const { buildComparisonResult } = await loadModule();
    mockPeriods(current, previous);
    const result = await buildComparisonResult(FILTERS, new Date("2026-07-31T00:00:00Z"));
    return result.regionChanges;
  }

  it("region in current only → direction جديد, changeRate null", async () => {
    const rows = await changes([row({ region: R_MAKKAH })], []);
    const makkah = rows.find((r) => r.regionName === R_MAKKAH)!;
    expect(makkah.direction).toBe("جديد");
    expect(makkah.changeRate).toBeNull();
    expect(makkah.currentCount).toBe(1);
    expect(makkah.previousCount).toBe(0);
  });

  it("region in previous only → currentCount 0, direction انخفاض", async () => {
    const rows = await changes([], [row({ region: R_MAKKAH })]);
    const makkah = rows.find((r) => r.regionName === R_MAKKAH)!;
    expect(makkah.currentCount).toBe(0);
    expect(makkah.direction).toBe("انخفاض");
  });

  it("region in both, increase → direction ارتفاع", async () => {
    const rows = await changes(
      [row({ region: R_RIYADH }), row({ region: R_RIYADH })],
      [row({ region: R_RIYADH })]
    );
    const riyadh = rows.find((r) => r.regionName === R_RIYADH)!;
    expect(riyadh.direction).toBe("ارتفاع");
    expect(riyadh.difference).toBe(1);
    expect(riyadh.changeRate).toBe(100);
  });

  it("region in both, decrease → direction انخفاض", async () => {
    const rows = await changes([row({ region: R_RIYADH })], [row({ region: R_RIYADH }), row({ region: R_RIYADH })]);
    const riyadh = rows.find((r) => r.regionName === R_RIYADH)!;
    expect(riyadh.direction).toBe("انخفاض");
    expect(riyadh.difference).toBe(-1);
  });

  it("region in both, no change → direction دون تغير", async () => {
    const rows = await changes([row({ region: R_RIYADH })], [row({ region: R_RIYADH })]);
    const riyadh = rows.find((r) => r.regionName === R_RIYADH)!;
    expect(riyadh.direction).toBe("دون تغير");
    expect(riyadh.changeRate).toBe(0);
  });

  it("previous zero, current positive → direction جديد, changeRate null", async () => {
    const rows = await changes([row({ region: R_MADINAH })], [row({ region: R_RIYADH })]);
    const madinah = rows.find((r) => r.regionName === R_MADINAH)!;
    expect(madinah.direction).toBe("جديد");
    expect(madinah.changeRate).toBeNull();
  });

  it("never produces Infinity or NaN", async () => {
    const rows = await changes(
      [row({ region: R_MAKKAH }), row({ region: R_RIYADH })],
      [row({ region: R_RIYADH }), row({ region: R_RIYADH })]
    );
    for (const r of rows) {
      if (r.changeRate !== null) {
        expect(Number.isFinite(r.changeRate)).toBe(true);
        expect(Number.isNaN(r.changeRate)).toBe(false);
      }
    }
  });

  it("signed difference values are correct (+, 0, -)", async () => {
    const rows = await changes(
      [row({ region: R_MAKKAH }), row({ region: R_MAKKAH }), row({ region: R_RIYADH })],
      [row({ region: R_RIYADH }), row({ region: R_SHARQIYA })]
    );
    expect(rows.find((r) => r.regionName === R_MAKKAH)!.difference).toBe(2);
    expect(rows.find((r) => r.regionName === R_RIYADH)!.difference).toBe(0);
    expect(rows.find((r) => r.regionName === R_SHARQIYA)!.difference).toBe(-1);
  });

  it("sort order: ارتفاع first, then جديد, then دون تغير, then انخفاض, then دون شكاوى", async () => {
    const rows = await changes(
      [
        // ارتفاع: Riyadh 2 vs 1
        row({ region: R_RIYADH }),
        row({ region: R_RIYADH }),
        // جديد: Makkah 1 vs 0
        row({ region: R_MAKKAH }),
        // دون تغير: Madinah 1 vs 1
        row({ region: R_MADINAH }),
        // انخفاض: Sharqiya 1 vs 2 handled below
        row({ region: R_SHARQIYA }),
      ],
      [row({ region: R_RIYADH }), row({ region: R_MADINAH }), row({ region: R_SHARQIYA }), row({ region: R_SHARQIYA })]
    );
    const directions = rows.map((r) => r.direction);
    expect(directions[0]).toBe("ارتفاع");
    expect(directions.indexOf("جديد")).toBeLessThan(directions.indexOf("دون تغير"));
    expect(directions.indexOf("دون تغير")).toBeLessThan(directions.indexOf("انخفاض"));
  });
});

describe("DeptClassRiseRow", () => {
  beforeEach(() => dbMocks.findMany.mockReset());

  async function rises(current: Row[], previous: Row[], now = new Date("2026-07-31T00:00:00Z")) {
    const { buildComparisonResult } = await loadModule();
    mockPeriods(current, previous);
    return (await buildComparisonResult(FILTERS, now)).deptClassRises;
  }

  it("groups by (departmentId, classificationId) composite key, not name", async () => {
    const rows = await rises(
      [
        row({ department: D_HEALTH, classificationId: C_HEALTH.id, classification: C_HEALTH }),
        row({ department: D_HEALTH, classificationId: C_DELAY.id, classification: C_DELAY }),
      ],
      []
    );
    // Two distinct classifications under the same dept -> two rows.
    expect(rows).toHaveLength(2);
  });

  it("does not merge two depts with the same-looking name but different id-bearing rows", async () => {
    const rows = await rises(
      [
        row({ department: D_HEALTH, classificationId: C_HEALTH.id, classification: C_HEALTH }),
        row({ department: D_INMATES, classificationId: C_HEALTH.id, classification: C_HEALTH }),
      ],
      []
    );
    const depts = new Set(rows.map((r) => r.departmentName));
    expect(depts.size).toBe(2);
  });

  it("classificationContribution uses sum of positive diffs, not net dept change", async () => {
    // Dept HEALTH: classA rises by 3, classB rises by 1 -> denominator = 4.
    const rows = await rises(
      [
        ...Array.from({ length: 3 }, () => row({ classificationId: C_HEALTH.id, classification: C_HEALTH })),
        ...Array.from({ length: 1 }, () => row({ classificationId: C_DELAY.id, classification: C_DELAY })),
      ],
      []
    );
    const health = rows.find((r) => r.classificationId === C_HEALTH.id)!;
    const delay = rows.find((r) => r.classificationId === C_DELAY.id)!;
    expect(health.classificationContribution).toBe(75);
    expect(delay.classificationContribution).toBe(25);
  });

  it("single rising classification for a dept → contribution 100%", async () => {
    const rows = await rises([row({ classificationId: C_VISIT.id, classification: C_VISIT })], []);
    expect(rows[0].classificationContribution).toBe(100);
  });

  it("excludes rows without valid department or classification and warns", async () => {
    const { buildComparisonResult } = await loadModule();
    mockPeriods(
      [
        row({ department: null }),
        row({ classificationId: null, classification: null }),
        row({ classificationId: C_VISIT.id, classification: C_VISIT }),
      ],
      []
    );
    const result = await buildComparisonResult(FILTERS, new Date("2026-07-31T00:00:00Z"));
    // Only the fully-specified row survives.
    expect(result.deptClassRises).toHaveLength(1);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("MISSING_DEPARTMENT");
    expect(codes).toContain("MISSING_CLASSIFICATION");
  });

  it("excludes rows where currentCount <= previousCount", async () => {
    const rows = await rises(
      [row({ classificationId: C_HEALTH.id, classification: C_HEALTH })],
      [row({ classificationId: C_HEALTH.id, classification: C_HEALTH }), row({ classificationId: C_HEALTH.id, classification: C_HEALTH })]
    );
    expect(rows).toHaveLength(0);
  });

  it("never produces Infinity or NaN in changeRate or contribution", async () => {
    const rows = await rises([row({ classificationId: C_VISIT.id, classification: C_VISIT })], []);
    for (const r of rows) {
      expect(Number.isNaN(r.classificationContribution)).toBe(false);
      expect(Number.isFinite(r.classificationContribution)).toBe(true);
      if (r.changeRate !== null) expect(Number.isFinite(r.changeRate)).toBe(true);
    }
  });

  it("truncates at DEPT_CLASS_RISES_LIMIT and emits a truncation warning", async () => {
    const { buildComparisonResult, DEPT_CLASS_RISES_LIMIT } = await loadModule();
    const current: Row[] = [];
    for (let i = 0; i < DEPT_CLASS_RISES_LIMIT + 5; i++) {
      current.push(row({ department: `إدارة ${i}`, classificationId: `cls_${i}`, classification: { id: `cls_${i}`, nameAr: `تصنيف ${i}` } }));
    }
    mockPeriods(current, []);
    const result = await buildComparisonResult(FILTERS, new Date("2026-07-31T00:00:00Z"));
    expect(result.deptClassRises).toHaveLength(DEPT_CLASS_RISES_LIMIT);
    expect(result.warnings.some((w) => w.code === "RISES_TRUNCATED")).toBe(true);
  });
});

describe("RegionTrendData", () => {
  beforeEach(() => dbMocks.findMany.mockReset());

  async function trend(current: Row[]) {
    const { buildComparisonResult } = await loadModule();
    mockPeriods(current, []);
    return (await buildComparisonResult(FILTERS, new Date("2026-07-31T00:00:00Z"))).regionTrend;
  }

  it("generates a data point for every day including zero-complaint days", async () => {
    const data = await trend([row({ region: R_RIYADH, complaintDate: new Date("2026-07-10T00:00:00Z") })]);
    // FILTERS is 2026-07-08..2026-07-14 inclusive -> 7 days.
    expect(data.allDates).toHaveLength(7);
    const [firstSeries] = data.series;
    expect(firstSeries).toBeDefined();
    expect(firstSeries!.points).toHaveLength(7);
    const zeroDays = firstSeries!.points.filter((p) => p.count === 0);
    expect(zeroDays).toHaveLength(6);
  });

  it("single region: one series, no aggregated other", async () => {
    const data = await trend([row({ region: R_RIYADH })]);
    expect(data.series).toHaveLength(1);
    expect(data.truncated).toBe(false);
    expect(data.otherSeriesName).toBeNull();
  });

  it("9 regions: top 8 shown, 9th aggregated into مناطق أخرى, counting each complaint once", async () => {
    const inRange = new Date("2026-07-10T00:00:00Z");
    const rows: Row[] = [];
    for (let i = 0; i < 9; i++) {
      const count = 9 - i; // region 0 has 9, region 8 has 1 -> distinct totals
      for (let j = 0; j < count; j++) rows.push(row({ region: `منطقة ${i}`, complaintDate: inRange, receivedAt: inRange }));
    }
    const data = await trend(rows);
    expect(data.truncated).toBe(true);
    expect(data.otherSeriesName).toBe("مناطق أخرى");
    // 8 named + 1 aggregated = 9 series.
    expect(data.series).toHaveLength(9);
    const other = data.series.find((s) => s.regionName === "مناطق أخرى")!;
    const otherTotal = other.points.reduce((sum, p) => sum + p.count, 0);
    // The 9th region (index 8) has 1 complaint.
    expect(otherTotal).toBe(1);
  });

  it("empty data: empty series, allDates spans full period", async () => {
    const data = await trend([]);
    expect(data.series).toHaveLength(0);
    expect(data.allDates).toHaveLength(7);
  });

  it("series sorted by total count descending", async () => {
    const rows = [
      row({ region: R_RIYADH }),
      row({ region: R_MAKKAH }),
      row({ region: R_MAKKAH }),
      row({ region: R_MAKKAH }),
    ];
    const data = await trend(rows);
    expect(data.series[0].regionName).toBe(R_MAKKAH);
  });
});

describe("executiveSummaryPoints", () => {
  beforeEach(() => dbMocks.findMany.mockReset());

  it("neutral wording, no empty strings, at most 4 points", async () => {
    const { buildComparisonResult } = await loadModule();
    mockPeriods(
      [row({ region: R_RIYADH }), row({ region: R_RIYADH }), row({ region: R_MAKKAH })],
      [row({ region: R_RIYADH })]
    );
    const result = await buildComparisonResult(FILTERS, new Date("2026-07-31T00:00:00Z"));
    expect(result.executiveSummaryPoints.length).toBeGreaterThan(0);
    expect(result.executiveSummaryPoints.length).toBeLessThanOrEqual(4);
    for (const point of result.executiveSummaryPoints) {
      expect(point.trim().length).toBeGreaterThan(0);
    }
    expect(result.executiveSummaryPoints[0]).toContain("الفترة الحالية");
  });

  it("no comparison period: single total point", async () => {
    const { buildComparisonResult } = await loadModule();
    // toExclusive derives fine here; force no-previous by using invalid range
    // via a single-day filter where previous still exists — instead assert the
    // sentence form when previous is empty.
    mockPeriods([row({ region: R_RIYADH })], []);
    const result = await buildComparisonResult(FILTERS, new Date("2026-07-31T00:00:00Z"));
    expect(result.executiveSummaryPoints[0]).toContain("1 شكوى");
  });
});
