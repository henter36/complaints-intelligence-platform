import { describe, expect, it } from "vitest";
import {
  apiErrorMessage,
  isAnalyticsData,
  isDashboardData,
  isRecord,
  readJsonResponse,
} from "./analytics-api-contract";

function validDashboard(): unknown {
  return {
    volume: {
      total: 10, open: 3, inProgress: 2, closed: 5,
      reopened: 0, rejected: 0, late: 1, repeated: 0,
      validated: 8, notValidated: 2, potentialDuplicates: 0,
    },
    performance: {
      closureRate: 50, onTimeRate: 75, lateRate: 10,
      avgFirstResponseHours: 2, avgProcessingHours: 4, avgOpenAgeHours: 6,
      overdueNoAction: 0, overdueNoActionRate: 0, reopenRate: 0,
      validityRate: 100, avgSatisfaction: 4, satisfactionRate: 80,
    },
    trend: {
      previousTotal: 8,
      growthRate: 15,
      trendData: [{ date: "2026-07-29", total: 10, closed: 5 }],
    },
    distributions: {
      byRegion: [], byDepartment: [], byClassification: [], byChannel: [],
      byStatus: [], byPriority: [], bySeverity: [],
    },
    alerts: {
      criticalComplaints: 0, lateCritical: 0, missingFields: 0, dataQualityRate: 100,
    },
  };
}

function validAnalytics(): unknown {
  return {
    crossTabs: {
      classifications: [], regions: [], departments: [],
      classificationByRegion: [], classificationByDepartment: [],
    },
    channelEffectiveness: [],
    delayReasons: [],
    recurringSubjects: [],
    recurringClassifications: [],
    anomalies: { regions: [], departments: [], classifications: [] },
    previousDistributions: null,
    regionPriorityBreakdown: [],
    totalCount: 10,
  };
}

describe("isRecord", () => {
  it("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("rejects null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("rejects arrays", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});

describe("readJsonResponse", () => {
  it("parses a valid JSON body", async () => {
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    await expect(readJsonResponse(response)).resolves.toEqual({ ok: true });
  });

  it("throws a safe Arabic message for a non-JSON body instead of the raw SyntaxError", async () => {
    const response = new Response("not-json{{{", { status: 200 });
    await expect(readJsonResponse(response)).rejects.toThrow("أعاد الخادم استجابة غير صالحة.");
  });
});

describe("apiErrorMessage", () => {
  it("returns error.message when present", () => {
    expect(apiErrorMessage({ error: { code: "X", message: "فشل الطلب" } }, "fallback")).toBe(
      "فشل الطلب"
    );
  });

  it("returns the fallback when payload is not a record", () => {
    expect(apiErrorMessage(null, "fallback")).toBe("fallback");
    expect(apiErrorMessage("string", "fallback")).toBe("fallback");
    expect(apiErrorMessage([1, 2], "fallback")).toBe("fallback");
    expect(apiErrorMessage(undefined, "fallback")).toBe("fallback");
  });

  it("returns the fallback when error is missing or not a record", () => {
    expect(apiErrorMessage({}, "fallback")).toBe("fallback");
    expect(apiErrorMessage({ error: "not-a-record" }, "fallback")).toBe("fallback");
    expect(apiErrorMessage({ error: null }, "fallback")).toBe("fallback");
  });

  it("returns the fallback when error.message is missing, blank, or not a string", () => {
    expect(apiErrorMessage({ error: {} }, "fallback")).toBe("fallback");
    expect(apiErrorMessage({ error: { message: "   " } }, "fallback")).toBe("fallback");
    expect(apiErrorMessage({ error: { message: 123 } }, "fallback")).toBe("fallback");
  });
});

describe("isDashboardData", () => {
  it("accepts a well-formed dashboard payload", () => {
    expect(isDashboardData(validDashboard())).toBe(true);
  });

  it("accepts growthRate: null (no previous-period data, not zero growth)", () => {
    const payload = validDashboard() as Record<string, any>;
    payload.trend.growthRate = null;
    expect(isDashboardData(payload)).toBe(true);
  });

  it("rejects an API error payload", () => {
    expect(isDashboardData({ error: { code: "DASHBOARD_QUERY_FAILED", message: "تعذر جلب مؤشرات لوحة التحكم" } })).toBe(
      false
    );
  });

  it("rejects null", () => {
    expect(isDashboardData(null)).toBe(false);
  });

  it("rejects an array", () => {
    expect(isDashboardData([])).toBe(false);
    expect(isDashboardData([validDashboard()])).toBe(false);
  });

  it("rejects a payload with a missing trend", () => {
    const payload = validDashboard() as Record<string, any>;
    delete payload.trend;
    expect(isDashboardData(payload)).toBe(false);
  });

  it("rejects growthRate as a string", () => {
    const payload = validDashboard() as Record<string, any>;
    payload.trend.growthRate = "15";
    expect(isDashboardData(payload)).toBe(false);
  });

  it("rejects trendData that is not an array", () => {
    const payload = validDashboard() as Record<string, any>;
    payload.trend.trendData = {};
    expect(isDashboardData(payload)).toBe(false);
  });

  it("rejects a payload missing volume, performance, distributions, or alerts", () => {
    for (const key of ["volume", "performance", "distributions", "alerts"]) {
      const payload = validDashboard() as Record<string, any>;
      delete payload[key];
      expect(isDashboardData(payload)).toBe(false);
    }
  });
});

describe("isAnalyticsData", () => {
  it("accepts a well-formed analytics payload", () => {
    expect(isAnalyticsData(validAnalytics())).toBe(true);
  });

  it("rejects a payload with anomalies missing", () => {
    const payload = validAnalytics() as Record<string, any>;
    delete payload.anomalies;
    expect(isAnalyticsData(payload)).toBe(false);
  });

  it("rejects null", () => {
    expect(isAnalyticsData(null)).toBe(false);
  });

  it("rejects an API error payload", () => {
    expect(isAnalyticsData({ error: { code: "ANALYTICS_QUERY_FAILED", message: "تعذر جلب التحليلات" } })).toBe(
      false
    );
  });

  it("rejects channelEffectiveness/delayReasons/recurringSubjects/recurringClassifications/regionPriorityBreakdown that are not arrays", () => {
    for (const key of [
      "channelEffectiveness",
      "delayReasons",
      "recurringSubjects",
      "recurringClassifications",
      "regionPriorityBreakdown",
    ]) {
      const payload = validAnalytics() as Record<string, any>;
      payload[key] = {};
      expect(isAnalyticsData(payload)).toBe(false);
    }
  });

  it("rejects a payload with crossTabs missing", () => {
    const payload = validAnalytics() as Record<string, any>;
    delete payload.crossTabs;
    expect(isAnalyticsData(payload)).toBe(false);
  });
});
