import { describe, it, expect } from "vitest";
import { ANALYSIS_SCHEMAS } from "./ai-contracts";

describe("AI contract schemas", () => {
  describe("EXECUTIVE_SUMMARY", () => {
    it("accepts valid structure", () => {
      const result = ANALYSIS_SCHEMAS.EXECUTIVE_SUMMARY.safeParse({
        summary: "ملخص",
        highlights: ["نتيجة 1"],
        significantChanges: [{ title: "تغيير", detail: "تفاصيل" }],
        riskAreas: [],
        improvementOpportunities: [],
        questionsForReview: [],
        limitations: ["قيد 1"],
      });
      expect(result.success).toBe(true);
    });

    it("rejects HTML in summary", () => {
      const result = ANALYSIS_SCHEMAS.EXECUTIVE_SUMMARY.safeParse({
        summary: "<script>alert('xss')</script>",
        highlights: [],
        significantChanges: [],
        riskAreas: [],
        improvementOpportunities: [],
        questionsForReview: [],
        limitations: [],
      });
      expect(result.success).toBe(false);
    });

    it("rejects text exceeding max length", () => {
      const result = ANALYSIS_SCHEMAS.EXECUTIVE_SUMMARY.safeParse({
        summary: "أ".repeat(3000),
        highlights: [],
        significantChanges: [],
        riskAreas: [],
        improvementOpportunities: [],
        questionsForReview: [],
        limitations: [],
      });
      expect(result.success).toBe(false);
    });

    it("rejects too many items in highlights", () => {
      const result = ANALYSIS_SCHEMAS.EXECUTIVE_SUMMARY.safeParse({
        summary: "ملخص",
        highlights: Array.from({ length: 25 }, (_, i) => `نتيجة ${i}`),
        significantChanges: [],
        riskAreas: [],
        improvementOpportunities: [],
        questionsForReview: [],
        limitations: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("RECURRING_TOPICS", () => {
    it("accepts valid structure", () => {
      const result = ANALYSIS_SCHEMAS.RECURRING_TOPICS.safeParse({
        summary: "ملخص",
        topics: [{
          label: "موضوع",
          description: "وصف",
          estimatedCount: 5,
          relatedDepartments: [],
          relatedRegions: [],
          exampleTexts: [],
          confidenceNote: "متوسطة",
        }],
        limitations: [],
      });
      expect(result.success).toBe(true);
    });

    it("rejects negative estimatedCount", () => {
      const result = ANALYSIS_SCHEMAS.RECURRING_TOPICS.safeParse({
        summary: "ملخص",
        topics: [{
          label: "موضوع",
          description: "وصف",
          estimatedCount: -1,
          relatedDepartments: [],
          relatedRegions: [],
          exampleTexts: [],
          confidenceNote: "متوسطة",
        }],
        limitations: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("IMPROVEMENT_OPPORTUNITIES", () => {
    it("accepts only valid priority values", () => {
      const invalid = ANALYSIS_SCHEMAS.IMPROVEMENT_OPPORTUNITIES.safeParse({
        summary: "ملخص",
        opportunities: [{
          opportunity: "فرصة",
          relatedProblem: "مشكلة",
          evidence: [],
          suggestedPriority: "CRITICAL", // invalid
          expectedImpact: "أثر",
          suggestedAction: "إجراء",
          followUpMetric: "مقياس",
        }],
        limitations: [],
      });
      expect(invalid.success).toBe(false);

      const valid = ANALYSIS_SCHEMAS.IMPROVEMENT_OPPORTUNITIES.safeParse({
        summary: "ملخص",
        opportunities: [{
          opportunity: "فرصة",
          relatedProblem: "مشكلة",
          evidence: [],
          suggestedPriority: "HIGH",
          expectedImpact: "أثر",
          suggestedAction: "إجراء",
          followUpMetric: "مقياس",
        }],
        limitations: [],
      });
      expect(valid.success).toBe(true);
    });
  });
});

describe("ANOMALY_ANALYSIS schema", () => {
  const validAnomaly = {
    summary: "ملخص",
    anomalies: [{
      affectedArea: "منطقة",
      observedPattern: "نمط",
      comparedTo: "مقارنة",
      magnitude: "حجم",
      possibleExplanations: ["تفسير"],
      assistantNote: "تنبيه",
    }],
    overallAssistantNote: "تنبيه عام",
    limitations: [],
  };

  it("accepts valid structure", () => {
    expect(ANALYSIS_SCHEMAS.ANOMALY_ANALYSIS.safeParse(validAnomaly).success).toBe(true);
  });

  it("rejects unknown fields (strictObject)", () => {
    const withExtra = { ...validAnomaly, extraField: "should-fail" };
    expect(ANALYSIS_SCHEMAS.ANOMALY_ANALYSIS.safeParse(withExtra).success).toBe(false);
  });

  it("rejects HTML in summary", () => {
    expect(ANALYSIS_SCHEMAS.ANOMALY_ANALYSIS.safeParse({ ...validAnomaly, summary: "<script>xss</script>" }).success).toBe(false);
  });

  it("rejects too many anomalies", () => {
    const tooMany = Array.from({ length: 21 }, () => validAnomaly.anomalies[0]);
    expect(ANALYSIS_SCHEMAS.ANOMALY_ANALYSIS.safeParse({ ...validAnomaly, anomalies: tooMany }).success).toBe(false);
  });

  it("rejects too many possibleExplanations", () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => `explanation ${i}`);
    const anomaly = { ...validAnomaly.anomalies[0], possibleExplanations: tooMany };
    expect(ANALYSIS_SCHEMAS.ANOMALY_ANALYSIS.safeParse({ ...validAnomaly, anomalies: [anomaly] }).success).toBe(false);
  });
});

describe("POSSIBLE_ROOT_CAUSES schema", () => {
  const validCauses = {
    summary: "ملخص",
    causes: [{
      possibleCause: "سبب محتمل",
      supportingIndicators: ["مؤشر"],
      counterIndicators: [],
      additionalDataNeeded: [],
      probabilityNote: "ملاحظة",
    }],
    questionsForReview: [],
    limitations: [],
  };

  it("accepts valid structure", () => {
    expect(ANALYSIS_SCHEMAS.POSSIBLE_ROOT_CAUSES.safeParse(validCauses).success).toBe(true);
  });

  it("rejects unknown fields (strictObject)", () => {
    expect(ANALYSIS_SCHEMAS.POSSIBLE_ROOT_CAUSES.safeParse({ ...validCauses, extra: "x" }).success).toBe(false);
  });

  it("rejects unknown fields in nested cause", () => {
    const cause = { ...validCauses.causes[0], extraCauseField: "x" };
    expect(ANALYSIS_SCHEMAS.POSSIBLE_ROOT_CAUSES.safeParse({ ...validCauses, causes: [cause] }).success).toBe(false);
  });

  it("rejects too many supportingIndicators", () => {
    const tooMany = Array.from({ length: 11 }, () => "مؤشر");
    const cause = { ...validCauses.causes[0], supportingIndicators: tooMany };
    expect(ANALYSIS_SCHEMAS.POSSIBLE_ROOT_CAUSES.safeParse({ ...validCauses, causes: [cause] }).success).toBe(false);
  });
});

describe("strictObject — unknown field rejection", () => {
  it("EXECUTIVE_SUMMARY rejects extra top-level fields", () => {
    const input = {
      summary: "ملخص",
      highlights: [],
      significantChanges: [],
      riskAreas: [],
      improvementOpportunities: [],
      questionsForReview: [],
      limitations: [],
      extraUnknown: "should-fail",
    };
    expect(ANALYSIS_SCHEMAS.EXECUTIVE_SUMMARY.safeParse(input).success).toBe(false);
  });

  it("RECURRING_TOPICS rejects extra fields inside topic", () => {
    const input = {
      summary: "ملخص",
      topics: [{
        label: "موضوع",
        description: "وصف",
        estimatedCount: 1,
        relatedDepartments: [],
        relatedRegions: [],
        exampleTexts: [],
        confidenceNote: "ملاحظة",
        extraField: "should-fail",
      }],
      limitations: [],
    };
    expect(ANALYSIS_SCHEMAS.RECURRING_TOPICS.safeParse(input).success).toBe(false);
  });
});

describe("limitedText HTML validator — no /g flag state bug", () => {
  it("rejects HTML consistently across repeated calls on the same schema instance", () => {
    // If the regex had /g flag, lastIndex would advance and alternating calls
    // would produce alternating true/false. Without /g, every call is correct.
    const htmlInput = {
      summary: "<b>bold</b>",
      highlights: [],
      significantChanges: [],
      riskAreas: [],
      improvementOpportunities: [],
      questionsForReview: [],
      limitations: [],
    };
    for (let i = 0; i < 6; i++) {
      const result = ANALYSIS_SCHEMAS.EXECUTIVE_SUMMARY.safeParse(htmlInput);
      expect(result.success).toBe(false);
    }
  });

  it("accepts clean text consistently across repeated calls", () => {
    const cleanInput = {
      summary: "ملخص",
      highlights: [],
      significantChanges: [],
      riskAreas: [],
      improvementOpportunities: [],
      questionsForReview: [],
      limitations: [],
    };
    for (let i = 0; i < 6; i++) {
      const result = ANALYSIS_SCHEMAS.EXECUTIVE_SUMMARY.safeParse(cleanInput);
      expect(result.success).toBe(true);
    }
  });
});
