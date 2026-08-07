import { describe, expect, it } from "vitest";
import {
  apiErrorMessage,
  isAnalyticsData,
  isDashboardData,
  isNameCountArray,
  isNameCountItem,
  isRecord,
  readJsonResponse,
} from "./analytics-api-contract";
import { makeAnalyticsData, makeDashboardData } from "./analytics-api-fixtures";

// A narrow, deliberate cast boundary for tests that need to write an
// invalid shape (wrong type, missing field) into an otherwise well-typed
// fixture. Confined to this helper so call sites never reach for `any`.
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function dashboardRecord(): Record<string, unknown> {
  return asRecord(structuredClone(makeDashboardData()));
}

function analyticsRecord(): Record<string, unknown> {
  return asRecord(structuredClone(makeAnalyticsData()));
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

  it("throws a safe Arabic message with the original error as `cause` for a non-JSON body", async () => {
    const response = new Response("not-json{{{", { status: 200 });

    try {
      await readJsonResponse(response);
      throw new Error("expected readJsonResponse to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("أعاد الخادم استجابة غير صالحة.");
      expect((error as Error).cause).toBeDefined();
    }
  });

  it("preserves AbortError while reading the body instead of wrapping it", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    const stream = new ReadableStream({
      start(controller) {
        controller.error(abortError);
      },
    });
    const response = new Response(stream);

    await expect(readJsonResponse(response)).rejects.toBe(abortError);
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

describe("isNameCountItem / isNameCountArray", () => {
  it("accepts a well-formed {name, count} item", () => {
    expect(isNameCountItem({ name: "الرياض", count: 10 })).toBe(true);
  });

  it("rejects a non-finite count, a missing name, or a non-record", () => {
    expect(isNameCountItem({ name: "الرياض", count: Number.NaN })).toBe(false);
    expect(isNameCountItem({ count: 10 })).toBe(false);
    expect(isNameCountItem({ name: "الرياض", count: "10" })).toBe(false);
    expect(isNameCountItem(null)).toBe(false);
  });

  it("accepts an empty array and rejects a non-array or an array with a bad item", () => {
    expect(isNameCountArray([])).toBe(true);
    expect(isNameCountArray([{ name: "x", count: 1 }])).toBe(true);
    expect(isNameCountArray({})).toBe(false);
    expect(isNameCountArray([{ name: "x", count: 1 }, { name: "y" }])).toBe(false);
  });
});

describe("isDashboardData", () => {
  it("accepts a well-formed dashboard payload", () => {
    expect(isDashboardData(makeDashboardData())).toBe(true);
  });

  it("accepts growthRate: null (no previous-period data, not zero growth)", () => {
    const payload = dashboardRecord();
    asRecord(payload.trend).growthRate = null;
    expect(isDashboardData(payload)).toBe(true);
  });

  it("rejects an API error payload", () => {
    expect(
      isDashboardData({ error: { code: "DASHBOARD_QUERY_FAILED", message: "تعذر جلب مؤشرات لوحة التحكم" } })
    ).toBe(false);
  });

  it("rejects null", () => {
    expect(isDashboardData(null)).toBe(false);
  });

  it("rejects an array", () => {
    expect(isDashboardData([])).toBe(false);
    expect(isDashboardData([makeDashboardData()])).toBe(false);
  });

  it("rejects a payload with a missing trend", () => {
    const payload = dashboardRecord();
    delete payload.trend;
    expect(isDashboardData(payload)).toBe(false);
  });

  it("rejects growthRate as a string", () => {
    const payload = dashboardRecord();
    asRecord(payload.trend).growthRate = "15";
    expect(isDashboardData(payload)).toBe(false);
  });

  it("rejects trendData that is not an array", () => {
    const payload = dashboardRecord();
    asRecord(payload.trend).trendData = {};
    expect(isDashboardData(payload)).toBe(false);
  });

  it("rejects a payload missing volume, performance, distributions, or alerts", () => {
    for (const key of ["volume", "performance", "distributions", "alerts"]) {
      const payload = dashboardRecord();
      delete payload[key];
      expect(isDashboardData(payload)).toBe(false);
    }
  });

  it.each([
    "byRegion",
    "byDepartment",
    "byClassification",
    "byChannel",
    "byStatus",
    "byPriority",
    "bySeverity",
  ])("rejects dashboard distributions.%s when it is not a valid {name, count} array", (key) => {
    for (const invalidValue of [{}, null, "invalid", [{ name: "x" }], [{ count: 1 }]]) {
      const payload = dashboardRecord();
      asRecord(payload.distributions)[key] = invalidValue;
      expect(isDashboardData(payload)).toBe(false);
    }
  });

  it("accepts a distributions object where every dimension is a valid {name, count} array", () => {
    const payload = dashboardRecord();
    expect(isDashboardData(payload)).toBe(true);
  });
});

describe("isAnalyticsData", () => {
  it("accepts a well-formed analytics payload", () => {
    expect(isAnalyticsData(makeAnalyticsData())).toBe(true);
  });

  it("rejects a payload with anomalies missing", () => {
    const payload = analyticsRecord();
    delete payload.anomalies;
    expect(isAnalyticsData(payload)).toBe(false);
  });

  it("rejects null", () => {
    expect(isAnalyticsData(null)).toBe(false);
  });

  it("rejects an API error payload", () => {
    expect(
      isAnalyticsData({ error: { code: "ANALYTICS_QUERY_FAILED", message: "تعذر جلب التحليلات" } })
    ).toBe(false);
  });

  it.each([
    "channelEffectiveness",
    "delayReasons",
    "recurringSubjects",
    "recurringClassifications",
    "regionPriorityBreakdown",
  ])("rejects %s when it is not an array", (key) => {
    const payload = analyticsRecord();
    payload[key] = {};
    expect(isAnalyticsData(payload)).toBe(false);
  });

  it("rejects a payload with crossTabs missing", () => {
    const payload = analyticsRecord();
    delete payload.crossTabs;
    expect(isAnalyticsData(payload)).toBe(false);
  });

  it.each(["classifications", "regions", "departments", "classificationByRegion", "classificationByDepartment"])(
    "rejects crossTabs.%s when it is not an array",
    (key) => {
      const payload = analyticsRecord();
      asRecord(payload.crossTabs)[key] = {};
      expect(isAnalyticsData(payload)).toBe(false);
    }
  );

  it("rejects crossTabs.classifications when it contains a non-string element", () => {
    const payload = analyticsRecord();
    asRecord(payload.crossTabs).classifications = ["ok", 5];
    expect(isAnalyticsData(payload)).toBe(false);
  });

  it.each(["regions", "departments", "classifications"])(
    "rejects anomalies.%s when it is not an array",
    (key) => {
      const payload = analyticsRecord();
      asRecord(payload.anomalies)[key] = {};
      expect(isAnalyticsData(payload)).toBe(false);
    }
  );

  it("rejects anomalies.regions/departments items missing average, deviation, or isAnomaly", () => {
    for (const key of ["regions", "departments"]) {
      const payload = analyticsRecord();
      asRecord(payload.anomalies)[key] = [{ name: "الرياض", count: 10 }];
      expect(isAnalyticsData(payload)).toBe(false);
    }
  });

  it("accepts well-formed anomalies.regions/departments/classifications", () => {
    const payload = analyticsRecord();
    asRecord(payload.anomalies).regions = [
      { name: "الرياض", count: 10, average: 5, deviation: 20, isAnomaly: true },
    ];
    asRecord(payload.anomalies).departments = [
      { name: "الطوارئ", count: 4, average: 2, deviation: 10, isAnomaly: false },
    ];
    asRecord(payload.anomalies).classifications = [{ name: "الخدمة", count: 3 }];
    expect(isAnalyticsData(payload)).toBe(true);
  });
});

describe("previousDistributions", () => {
  it("accepts null", () => {
    const payload = analyticsRecord();
    payload.previousDistributions = null;
    expect(isAnalyticsData(payload)).toBe(true);
  });

  it("accepts a valid core-distributions record", () => {
    const payload = analyticsRecord();
    payload.previousDistributions = {
      byRegion: [{ name: "الرياض", count: 5 }],
      byDepartment: [{ name: "الطوارئ", count: 5 }],
      byClassification: [{ name: "الخدمة", count: 5 }],
      byChannel: [{ name: "هاتف", count: 5 }],
    };
    expect(isAnalyticsData(payload)).toBe(true);
  });

  it("rejects an empty object", () => {
    const payload = analyticsRecord();
    payload.previousDistributions = {};
    expect(isAnalyticsData(payload)).toBe(false);
  });

  it("rejects byRegion that is not an array", () => {
    const payload = analyticsRecord();
    payload.previousDistributions = {
      byRegion: {},
      byDepartment: [],
      byClassification: [],
      byChannel: [],
    };
    expect(isAnalyticsData(payload)).toBe(false);
  });

  it("rejects byDepartment that is null", () => {
    const payload = analyticsRecord();
    payload.previousDistributions = {
      byRegion: [],
      byDepartment: null,
      byClassification: [],
      byChannel: [],
    };
    expect(isAnalyticsData(payload)).toBe(false);
  });
});
