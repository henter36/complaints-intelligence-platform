import { describe, expect, it } from "vitest";
import {
  selectOperationalPractices,
  OPERATIONAL_PRACTICES,
  GENERAL_OPERATIONAL_PRACTICE_IDS,
  OPERATIONAL_PRACTICE_CARD_COUNT,
  type SelectOperationalPracticesInput,
} from "./operational-practices";
import type { ClassificationTrendRow, FacilityFollowUpRow } from "./report-contract";
import type { AnalyticalFinding } from "@/lib/analytics/analytical-finding";

const PERIOD = { from: "2026-01-01", to: "2026-01-31" };

function trendRow(overrides: Partial<ClassificationTrendRow> = {}): ClassificationTrendRow {
  return {
    facility: "سجن الملز",
    classification: "الوصول إلى الطبيب",
    currentCount: 10,
    difference: 2,
    trail: "8، 9، 10",
    streakPeriods: 3,
    patternLabel: "استمرار مرتفع",
    priorityScore: 75,
    ...overrides,
  };
}

function followUpRow(overrides: Partial<FacilityFollowUpRow> = {}): FacilityFollowUpRow {
  return {
    facility: "سجن الملز",
    totalComplaints: 20,
    isHistoricalOnly: false,
    topIssueLabel: "الوصول إلى الطبيب",
    patternLabel: "استمرار مرتفع",
    streakPeriods: 3,
    repeatComplainants: null,
    repeatComplaints: null,
    spreadComplainants: null,
    spreadComplaints: null,
    priorityBand: "مرتفعة",
    priorityScore: 75,
    isChronic: false,
    distinctComplainantsForRanking: 0,
    ...overrides,
  };
}

function chronicFinding(label: string, facility: string, overrides: Partial<AnalyticalFinding> = {}): AnalyticalFinding {
  return {
    id: overrides.id ?? `chronic-${label}-${facility}`,
    type: "CHRONIC_ISSUE",
    entityType: "CLASSIFICATION",
    entityId: `cls-${label}`,
    entityName: `${facility} — ${label}`,
    currentValue: 12,
    previousValue: 12,
    difference: 0,
    changeRate: 0,
    severity: "HIGH",
    priorityScore: 80,
    confidence: "HIGH",
    detectionSource: "QUANTITATIVE",
    explanation: "x",
    supportingMetrics: { streakPeriods: 5 },
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: [],
    drilldownFilters: { facility },
    firstDetectedAt: "2026-01-01T00:00:00.000Z",
    lastDetectedAt: "2026-01-01T00:00:00.000Z",
    detectorVersion: "pattern-v1",
    ...overrides,
  };
}

function baseInput(overrides: Partial<SelectOperationalPracticesInput> = {}): SelectOperationalPracticesInput {
  return {
    classificationTrends: [],
    facilitiesNeedingFollowUp: [],
    patternFindings: [],
    recentPracticeIds: [],
    reportPeriod: PERIOD,
    ...overrides,
  };
}

const ALL_PRACTICE_IDS = new Set(OPERATIONAL_PRACTICES.map((p) => p.id));

describe("selectOperationalPractices", () => {
  it("1. returns 4 practices when normal data is available", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          trendRow({ classification: "الوصول إلى الطبيب", priorityScore: 85, currentCount: 30 }),
          trendRow({ classification: "استمرارية العلاج والأدوية", facility: "سجن ب", priorityScore: 78, currentCount: 25 }),
        ],
      })
    );
    expect(result).toHaveLength(4);
    expect(new Set(result.map((r) => r.id)).size).toBe(4);
    for (const row of result) expect(ALL_PRACTICE_IDS.has(row.id)).toBe(true);
  });

  it("2. top-3 distinct topics (health + medication + agencies) each get a matching practice + 1 general", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          trendRow({ facility: "سجن الملز", classification: "الوصول إلى الطبيب", priorityScore: 85, currentCount: 30, patternLabel: "استمرار مرتفع" }),
          trendRow({ facility: "سجن ب", classification: "استمرارية العلاج والأدوية", priorityScore: 78, currentCount: 25, patternLabel: "تصاعد مستمر" }),
          trendRow({ facility: "سجن ج", classification: "الوكالات والخدمات الشخصية", priorityScore: 72, currentCount: 20, patternLabel: "استمرار مرتفع" }),
        ],
      })
    );
    expect(result.map((r) => r.id)).toEqual([
      "daily-health-request-followup",
      "medication-continuity",
      "agency-service-control",
      expect.any(String),
    ]);
    expect(result[3].selectionReason).toBe("GENERAL_ROTATION");
    expect(GENERAL_OPERATIONAL_PRACTICE_IDS).toContain(result[3].id);
  });

  it("2b (governance review): health + agencies + medication rank above weaker topics => 3 topic-specific practices + 1 GENERAL, never hardcoded", () => {
    // Mirrors a real report's top classifications: health, agencies, and
    // medication are the genuinely strong (chronic/high-priority) signals;
    // "متابعة المعاملات" and "الأمانات والمقتنيات" are present but weaker,
    // so they must NOT displace agencies/medication from the top 3.
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          trendRow({ facility: "سجن الملز", classification: "الوصول إلى الطبيب والخدمة الصحية", priorityScore: 90, currentCount: 30, patternLabel: "استمرار مرتفع" }),
          trendRow({ facility: "سجن ب", classification: "الوكالات", priorityScore: 85, currentCount: 25, patternLabel: "استمرار مرتفع" }),
          trendRow({ facility: "سجن ج", classification: "استمرارية العلاج والدواء", priorityScore: 80, currentCount: 20, patternLabel: "تصاعد مستمر" }),
          trendRow({ facility: "سجن د", classification: "متابعة المعاملات", priorityScore: 60, currentCount: 15, patternLabel: "نمط ملحوظ" }),
          trendRow({ facility: "سجن هـ", classification: "الأمانات والمقتنيات", priorityScore: 55, currentCount: 10, patternLabel: "نمط ملحوظ" }),
        ],
      })
    );
    expect(result).toHaveLength(4);
    expect(result.slice(0, 3).map((r) => r.id)).toEqual([
      "daily-health-request-followup",
      "agency-service-control",
      "medication-continuity",
    ]);
    expect(result.slice(0, 3).every((r) => r.selectionReason !== "GENERAL_ROTATION")).toBe(true);
    expect(result[3].selectionReason).toBe("GENERAL_ROTATION");
    // Never the weaker topics' practices — they legitimately ranked below the top 3.
    expect(result.map((r) => r.id)).not.toContain("request-tracking-number");
    expect(result.map((r) => r.id)).not.toContain("belongings-custody-control");
  });

  it("2c (governance review): 3 important distinct topics never produce 2 GENERAL practices", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          trendRow({ facility: "سجن الملز", classification: "الوصول إلى الطبيب والخدمة الصحية", priorityScore: 90, currentCount: 30, patternLabel: "استمرار مرتفع" }),
          trendRow({ facility: "سجن ب", classification: "الوكالات", priorityScore: 85, currentCount: 25, patternLabel: "استمرار مرتفع" }),
          trendRow({ facility: "سجن ج", classification: "استمرارية العلاج والدواء", priorityScore: 80, currentCount: 20, patternLabel: "تصاعد مستمر" }),
        ],
      })
    );
    const generalCount = result.filter((r) => r.selectionReason === "GENERAL_ROTATION").length;
    expect(generalCount).toBe(1);
  });

  it("3. never picks the same practice id twice", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          trendRow({ classification: "الوصول إلى الطبيب", priorityScore: 90, currentCount: 30 }),
          trendRow({ classification: "طبيب مختص بالعيون", facility: "سجن ب", priorityScore: 89, currentCount: 29 }),
          trendRow({ classification: "كشف طبي دوري", facility: "سجن ج", priorityScore: 88, currentCount: 28 }),
        ],
      })
    );
    expect(new Set(result.map((r) => r.id)).size).toBe(result.length);
  });

  it("4. does not pick 3 practices from the same topic when another important topic exists", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          trendRow({ facility: "سجن أ", classification: "الوصول إلى الطبيب", priorityScore: 90, currentCount: 30, patternLabel: "استمرار مرتفع" }),
          trendRow({ facility: "سجن ب", classification: "فرز الحالة العاجلة", priorityScore: 89, currentCount: 29, patternLabel: "تصاعد مستمر" }),
          trendRow({ facility: "سجن ج", classification: "الوكالات والخدمات الشخصية", priorityScore: 88, currentCount: 28, patternLabel: "استمرار مرتفع" }),
        ],
      })
    );
    const dataLinkedTopics = result.slice(0, 3).map((r) => r.topic);
    expect(new Set(dataLinkedTopics).size).toBeGreaterThanOrEqual(2);
  });

  it("5. deterministic: same input always produces the same 4 ids", () => {
    const input = baseInput({
      classificationTrends: [
        trendRow({ classification: "الوصول إلى الطبيب", priorityScore: 85, currentCount: 30 }),
      ],
    });
    const first = selectOperationalPractices(input).map((r) => r.id);
    const second = selectOperationalPractices(input).map((r) => r.id);
    expect(second).toEqual(first);
  });

  it("6. does not rely on a low-volume percentage spike alone", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          // Huge % spike but trivial absolute volume — must not out-rank the real problem below.
          trendRow({ facility: "سجن أ", classification: "الوصول إلى الطبيب", priorityScore: 95, currentCount: 2, patternLabel: "تصاعد مستمر" }),
          trendRow({ facility: "سجن ب", classification: "استمرارية العلاج والأدوية", priorityScore: 72, currentCount: 40, patternLabel: "استمرار مرتفع" }),
        ],
      })
    );
    const medicationIndex = result.findIndex((r) => r.id === "medication-continuity");
    const healthIndex = result.findIndex((r) => r.id === "daily-health-request-followup");
    expect(medicationIndex).toBeGreaterThanOrEqual(0);
    // The low-volume spike topic must not out-rank the real, higher-volume signal.
    if (healthIndex >= 0) expect(medicationIndex).toBeLessThan(healthIndex);
  });

  it("7. chronic/high-priority problems outrank plain high volume with no negative signal", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          // Very high current count, but a neutral/no-signal pattern label — just raw volume.
          trendRow({ facility: "سجن أ", classification: "الوكالات والخدمات الشخصية", priorityScore: 30, currentCount: 500, patternLabel: "نمط ملحوظ" }),
        ],
        patternFindings: [chronicFinding("استمرارية العلاج والأدوية", "سجن ب")],
      })
    );
    const chronicIndex = result.findIndex((r) => r.id === "medication-continuity");
    const volumeIndex = result.findIndex((r) => r.id === "agency-service-control");
    expect(chronicIndex).toBe(0);
    expect(volumeIndex).toBeGreaterThan(chronicIndex);
  });

  it("8. a practice shown in the last 3 reports is excluded when the topic is no longer a top problem", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          // Low priority, low volume, neutral pattern — not chronic, not a
          // high-priority negative signal, and not this period's top-volume
          // topic either (the other row below outranks it), so the
          // persistent-problem exception must NOT kick in.
          trendRow({ facility: "سجن أ", classification: "الوصول إلى الطبيب", priorityScore: 40, currentCount: 3, patternLabel: "نمط ملحوظ" }),
          trendRow({ facility: "سجن ب", classification: "مشكلة أخرى غير مرتبطة", priorityScore: 50, currentCount: 15, patternLabel: "متذبذب" }),
        ],
        recentPracticeIds: ["daily-health-request-followup"],
      })
    );
    // urgent-health-case-triage is the only other HEALTH_ACCESS-matchable
    // practice, but nothing here matches "حالة عاجلة/مرض/تسمم/خطر صحي" — so
    // with no data-linked alternative and no persistence exception, this
    // topic is simply skipped rather than repeating the recent practice.
    expect(result.map((r) => r.id)).not.toContain("daily-health-request-followup");
  });

  it("9. persistent high-priority exception: a recent practice may repeat when no equivalent alternative exists and the problem remains high priority", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          trendRow({ facility: "سجن أ", classification: "الوصول إلى الطبيب", priorityScore: 90, currentCount: 30, patternLabel: "استمرار مرتفع" }),
        ],
        patternFindings: [chronicFinding("الوصول إلى الطبيب", "سجن أ")],
        recentPracticeIds: ["daily-health-request-followup"],
      })
    );
    const picked = result.find((r) => r.id === "daily-health-request-followup");
    expect(picked).toBeDefined();
    expect(picked?.selectionReason).toBe("PERSISTENT_PROBLEM");
  });

  it("10. fallback: completes the 4 from the general pool when there aren't enough classification matches", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          trendRow({ classification: "موضوع غير معروف تماماً", priorityScore: 10, currentCount: 3, patternLabel: "متذبذب" }),
        ],
      })
    );
    expect(result).toHaveLength(4);
    const generalCount = result.filter((r) => r.selectionReason === "GENERAL_ROTATION").length;
    expect(generalCount).toBeGreaterThanOrEqual(3);
    for (const row of result.filter((r) => r.selectionReason === "GENERAL_ROTATION")) {
      expect(GENERAL_OPERATIONAL_PRACTICE_IDS).toContain(row.id);
    }
  });

  it("11. an empty report (no complaints/findings) never crashes and shows 4 deterministic general practices", () => {
    const result = selectOperationalPractices(baseInput());
    expect(result).toHaveLength(4);
    expect(result.every((r) => r.selectionReason === "GENERAL_ROTATION")).toBe(true);
    expect(new Set(result.map((r) => r.id)).size).toBe(4);
  });

  it("12. Arabic normalization: hamza/tashkeel/tatweel/whitespace differences never block matching", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          trendRow({
            classification: "اَلْوُصُــول  إلي   الطَّبيب", // tashkeel + tatweel + extra spaces + إ variant
            priorityScore: 85,
            currentCount: 30,
          }),
        ],
      })
    );
    expect(result.map((r) => r.id)).toContain("daily-health-request-followup");
  });

  it("never selects the BestPracticeCandidate-narrating practice (cross-facility-knowledge-transfer)", () => {
    const result = selectOperationalPractices(
      baseInput({
        classificationTrends: [
          trendRow({ classification: "السجون ذات التحسن المستدام ومقارنة المواقع", priorityScore: 90, currentCount: 30 }),
        ],
      })
    );
    expect(result.map((r) => r.id)).not.toContain("cross-facility-knowledge-transfer");
  });

  it("caps at OPERATIONAL_PRACTICE_CARD_COUNT even with abundant matching data", () => {
    const rows = OPERATIONAL_PRACTICES.filter((p) => !p.isGeneral).map((p, idx) =>
      trendRow({
        facility: `سجن ${idx}`,
        classification: p.classificationMatchers[0],
        priorityScore: 95 - idx,
        currentCount: 50 - idx,
      })
    );
    const result = selectOperationalPractices(baseInput({ classificationTrends: rows }));
    expect(result.length).toBeLessThanOrEqual(OPERATIONAL_PRACTICE_CARD_COUNT);
  });
});
