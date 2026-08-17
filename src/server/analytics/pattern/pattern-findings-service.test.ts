import { describe, expect, it } from "vitest";
import type { HalfOpenDateRange } from "@/lib/reports/period-range";
import { computePatternFindings, computePeriodChangeDigest } from "./pattern-findings-service";
import type { PatternSeries, PatternSeriesRecord } from "./pattern-period-series-service";

const DAY_MS = 24 * 60 * 60 * 1000;

function buildPeriods(count: number): HalfOpenDateRange[] {
  const base = new Date("2026-01-01T00:00:00.000Z").getTime();
  const periods: HalfOpenDateRange[] = [];
  for (let i = 0; i < count; i++) {
    periods.push({
      from: new Date(base + i * 30 * DAY_MS),
      toExclusive: new Date(base + (i + 1) * 30 * DAY_MS),
    });
  }
  return periods;
}

function genCountRecords(
  facility: string,
  classificationId: string,
  classificationLabel: string,
  counts: number[],
  idPrefix: string
): PatternSeriesRecord[] {
  const records: PatternSeriesRecord[] = [];
  counts.forEach((count, periodIndex) => {
    for (let j = 0; j < count; j++) {
      records.push({
        complaintId: `${idPrefix}-${periodIndex}-${j}`,
        periodIndex,
        facility,
        classificationId,
        classificationLabel,
        subject: classificationLabel,
        // Shared per period/cell by default so a cell with several complaints
        // in one period isn't mistaken for many distinct complainants; tests
        // that need real repeats or mass-complaint spread override this.
        complainantIdentifier: `${idPrefix}-id-p${periodIndex}`,
        wingCode: null,
        isPotentialDuplicate: false,
        duplicateOfId: null,
      });
    }
  });
  return records;
}

function buildFixtureSeries(): PatternSeries {
  const periods = buildPeriods(7);
  const records: PatternSeriesRecord[] = [];

  // سجن أ — التغذية: continued rise, chronic (streak 5), with a repeating complainant.
  const food = genCountRecords("سجن أ", "cls-food", "التغذية", [3, 3, 8, 8, 8, 8, 8], "food");
  // Make one complainant repeat across five periods (same topic, same facility) — enough
  // volume to clear detectRepeatComplainants' own minimum-signal threshold.
  for (const periodIndex of [2, 3, 4, 5, 6]) {
    const target = food.find((r) => r.periodIndex === periodIndex && r.complaintId.endsWith("-0"));
    if (target) target.complainantIdentifier = "REPEAT-1";
  }
  // One record with a missing complainant identifier — must not crash and must not count as a repeat.
  const missingIdRecord = food.find((r) => r.periodIndex === 6 && r.complaintId.endsWith("-1"));
  if (missingIdRecord) missingIdRecord.complainantIdentifier = null;
  records.push(...food);

  // Technical import duplicate at سجن أ / التغذية — must not inflate the count.
  records.push({
    complaintId: "food-dup-1",
    periodIndex: 6,
    facility: "سجن أ",
    classificationId: "cls-food",
    classificationLabel: "التغذية",
    subject: "التغذية",
    complainantIdentifier: "REPEAT-1",
    wingCode: null,
    isPotentialDuplicate: true,
    duplicateOfId: "food-6-0",
  });

  // سجن أ — الاتصال: emerging (absent, then a real spike) — makes سجن أ a multi-issue facility.
  records.push(...genCountRecords("سجن أ", "cls-contact", "الاتصال", [0, 0, 0, 0, 0, 0, 7], "contact"));

  // سجن أ / سجن ب / سجن د — الرعاية الصحية: simultaneous material rise -> cross-facility spread.
  records.push(...genCountRecords("سجن أ", "cls-health", "الرعاية الصحية", [5, 5, 5, 5, 5, 5, 10], "healthA"));
  records.push(...genCountRecords("سجن ب", "cls-health", "الرعاية الصحية", [5, 5, 5, 5, 5, 5, 10], "healthB"));
  records.push(...genCountRecords("سجن د", "cls-health", "الرعاية الصحية", [5, 5, 5, 5, 5, 5, 10], "healthD"));

  // سجن ب — سلوك الموظفين: sustained, multi-period improvement.
  records.push(...genCountRecords("سجن ب", "cls-behavior", "سلوك الموظفين", [20, 15, 10, 8, 6, 5, 4], "behavior"));

  // سجن ج — النظافة: mass complaint — many distinct complainants in the current period only.
  const clean = genCountRecords("سجن ج", "cls-clean", "النظافة", [0, 0, 0, 0, 0, 0, 6], "clean");
  clean.forEach((r, i) => { r.complainantIdentifier = `clean-distinct-${i}`; });
  records.push(...clean);

  // سجن هـ — composition shift: total stable, one classification falls, another rises and becomes top.
  records.push(...genCountRecords("سجن هـ", "cls-x", "س1", [40, 40, 40, 40, 40, 40, 15], "x"));
  records.push(...genCountRecords("سجن هـ", "cls-y", "س2", [18, 18, 18, 18, 18, 18, 45], "y"));

  return { periods, records };
}

describe("computePatternFindings", () => {
  const findings = computePatternFindings(buildFixtureSeries());

  it("flags a chronic issue with the actual (duplicate-excluded) volume", () => {
    const chronic = findings.find((f) => f.type === "CHRONIC_ISSUE" && f.entityName.includes("التغذية"));
    expect(chronic).toBeDefined();
    expect(chronic!.currentValue).toBe(8); // not 9 — the technical duplicate must not count
    expect(chronic!.explanation).toContain("مشكلة مزمنة بسبب");
  });

  it("flags an emerging trend as TREND_PATTERN, not chronic (too short a streak)", () => {
    const trend = findings.find((f) => f.type === "TREND_PATTERN" && f.entityName.includes("الاتصال"));
    expect(trend).toBeDefined();
    expect(findings.some((f) => f.type === "CHRONIC_ISSUE" && f.entityName.includes("الاتصال"))).toBe(false);
  });

  it("flags a sustained, multi-period improvement", () => {
    const improvement = findings.find((f) => f.type === "SUSTAINED_IMPROVEMENT");
    expect(improvement).toBeDefined();
    expect(improvement!.currentValue).toBeLessThan(improvement!.previousValue!);
  });

  it("flags a mass complaint (many distinct complainants) separately from repeat complainants", () => {
    const mass = findings.find((f) => f.type === "MASS_COMPLAINT");
    expect(mass).toBeDefined();
    expect(mass!.supportingMetrics.distinctComplainants).toBe(6);
  });

  it("flags the repeating complainant at سجن أ, excluding the missing-identifier record", () => {
    const repeat = findings.find((f) => f.type === "REPEAT_COMPLAINANT" && f.entityName === "سجن أ");
    expect(repeat).toBeDefined();
    expect(repeat!.supportingMetrics.repeatComplainantCount).toBe(1);
  });

  it("rolls up the simultaneous rise across three facilities into one cross-facility finding", () => {
    const spread = findings.find((f) => f.type === "CROSS_FACILITY_SPREAD");
    expect(spread).toBeDefined();
    expect(spread!.supportingMetrics.affectedFacilityCount).toBe(3);
  });

  it("flags سجن أ as a multi-issue facility (two simultaneous negative classifications)", () => {
    const multi = findings.find((f) => f.type === "MULTI_ISSUE_FACILITY" && f.entityName === "سجن أ");
    expect(multi).toBeDefined();
    expect(multi!.currentValue).toBeGreaterThanOrEqual(2);
  });

  it("detects the composition shift at سجن هـ while its total stays flat", () => {
    const shift = findings.find((f) => f.type === "COMPOSITION_SHIFT");
    expect(shift).toBeDefined();
    expect(shift!.supportingMetrics.becameTopClassification).toBe(true);
  });

  it("every finding is traceable to real drilldown filters", () => {
    for (const finding of findings) {
      expect(Object.keys(finding.drilldownFilters).length).toBeGreaterThan(0);
    }
  });
});

describe("computePatternFindings — data quality", () => {
  it("returns nothing when the window is shorter than the minimum required periods", () => {
    const shortSeries: PatternSeries = {
      periods: buildPeriods(2),
      records: genCountRecords("سجن أ", "cls-food", "التغذية", [8, 8], "short"),
    };
    expect(computePatternFindings(shortSeries)).toEqual([]);
  });
});

describe("computePeriodChangeDigest", () => {
  it("reports the emerging contact-classification issue as new", () => {
    const digest = computePeriodChangeDigest(buildFixtureSeries());
    expect(digest.newProblems.some((p) => p.classificationLabel === "الاتصال" && p.facility === "سجن أ")).toBe(true);
  });
});

describe("computePatternFindings — SUSTAINED_IMPROVEMENT previousValue (regression)", () => {
  it("uses the real peak-before-decline, not the pre-window period, even when they coincidentally match currentValue", () => {
    // 7 periods fetched; the classifier only evaluates periods[1..6]. period[0]
    // (the pre-window period) happens to equal the current value here — using
    // it as "previousValue" would report a misleading zero decrease even
    // though periods[1..6] show a real, sustained, multi-period decline.
    const series: PatternSeries = {
      periods: buildPeriods(7),
      records: genCountRecords("سجن و", "cls-relapse-safe", "الصيانة", [4, 20, 15, 10, 8, 6, 4], "safe"),
    };
    const findings = computePatternFindings(series);
    const improvement = findings.find((f) => f.type === "SUSTAINED_IMPROVEMENT");
    expect(improvement).toBeDefined();
    expect(improvement!.previousValue).toBe(20);
    expect(improvement!.difference).toBe(4 - 20);
    expect(improvement!.currentValue).toBeLessThan(improvement!.previousValue!);
    expect(improvement!.explanation).toContain("من 20 إلى 4");
  });
});
