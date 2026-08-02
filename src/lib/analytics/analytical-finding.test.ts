import { describe, expect, it } from "vitest";
import { parseAnalyticalFinding } from "./analytical-finding";

const validFinding = {
  id: "finding-1",
  type: "TEXT_RISK",
  entityType: "REGION",
  entityId: "region-1",
  entityName: "الرياض",
  currentValue: 4,
  previousValue: 1,
  difference: 3,
  changeRate: 300,
  severity: "HIGH",
  priorityScore: 82,
  confidence: "MEDIUM",
  detectionSource: "RULE",
  explanation: "تكررت إشارات تعطل خدمة حيوية في أوصاف الشكاوى.",
  supportingMetrics: {
    complaintCount: 4,
    affectedFacilities: 2,
  },
  evidenceComplaintIds: ["complaint-1", "complaint-2"],
  evidenceSpans: ["انقطاع المياه مستمر منذ يومين"],
  limitations: ["الإشارة مستخرجة من نص الشكوى وتحتاج تحققًا بشريًا."],
  drilldownFilters: {
    regionId: "region-1",
    textRiskType: "SERVICE_OUTAGE",
    isLate: true,
  },
  firstDetectedAt: "2026-08-02T10:00:00.000Z",
  lastDetectedAt: "2026-08-02T11:00:00.000Z",
  detectorVersion: "rule-v1",
} as const;

describe("AnalyticalFindingSchema", () => {
  it("accepts a traceable finding with evidence and drilldown filters", () => {
    expect(parseAnalyticalFinding(validFinding)).toEqual(validFinding);
  });

  it("rejects an unsupported finding type", () => {
    expect(() => parseAnalyticalFinding({
      ...validFinding,
      type: "UNSUPPORTED_FINDING",
    })).toThrow();
  });

  it("rejects priority scores outside the documented range", () => {
    expect(() => parseAnalyticalFinding({
      ...validFinding,
      priorityScore: 101,
    })).toThrow();
  });

  it("rejects unknown fields so contracts cannot silently drift", () => {
    expect(() => parseAnalyticalFinding({
      ...validFinding,
      unreviewedClaim: "unsupported",
    })).toThrow();
  });
});
