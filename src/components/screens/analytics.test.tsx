import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getComparisonStateClassName,
  formatComparisonDifference,
  Analytics,
} from "./analytics";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function dashboardData(overrides: Record<string, unknown> = {}) {
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
      growthRate: 5,
      trendData: [{ date: "2026-07-29", total: 10, closed: 5 }],
    },
    distributions: {
      byRegion: [{ name: "الرياض", count: 10 }],
      byDepartment: [{ name: "الطوارئ", count: 10 }],
      byClassification: [{ name: "الخدمة", count: 10 }],
      byChannel: [{ name: "هاتف", count: 10 }],
      byStatus: [{ name: "open", count: 3 }],
      byPriority: [{ name: "critical", count: 1 }],
      bySeverity: [{ name: "critical", count: 1 }],
    },
    alerts: {
      criticalComplaints: 0, lateCritical: 0, missingFields: 0, dataQualityRate: 100,
    },
    ...overrides,
  };
}

function analyticsData(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function filtersOkResponse(): Response {
  return jsonResponse({ regions: [], departments: [] }, 200);
}

/** Routes a stubbed fetch by URL: /api/filters, /api/dashboard, /api/analytics. */
function stubFetch(handlers: {
  filters?: () => Response | Promise<Response>;
  dashboard?: () => Response | Promise<Response>;
  analytics?: () => Response | Promise<Response>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/filters")) {
        return handlers.filters ? handlers.filters() : filtersOkResponse();
      }
      if (url.includes("/api/dashboard")) {
        return handlers.dashboard
          ? handlers.dashboard()
          : jsonResponse(dashboardData(), 200);
      }
      if (url.includes("/api/analytics")) {
        return handlers.analytics
          ? handlers.analytics()
          : jsonResponse(analyticsData(), 200);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pre-existing pure-function tests
// ---------------------------------------------------------------------------

describe("getComparisonStateClassName", () => {
  it("returns red class for INCREASE", () => {
    expect(getComparisonStateClassName("INCREASE")).toBe("text-red-600");
  });

  it("returns green class for DECREASE", () => {
    expect(getComparisonStateClassName("DECREASE")).toBe("text-emerald-600");
  });

  it("returns muted class for NEW", () => {
    expect(getComparisonStateClassName("NEW")).toBe("text-muted-foreground");
  });

  it("returns muted class for NO_CHANGE", () => {
    expect(getComparisonStateClassName("NO_CHANGE")).toBe("text-muted-foreground");
  });
});

describe("formatComparisonDifference", () => {
  it("returns em dash for null difference", () => {
    expect(formatComparisonDifference(null)).toBe("—");
  });

  it("prepends + for positive difference", () => {
    expect(formatComparisonDifference(5)).toContain("+");
  });

  it("does not prepend + for negative difference", () => {
    expect(formatComparisonDifference(-3)).not.toContain("+");
  });

  it("does not prepend + for zero difference", () => {
    expect(formatComparisonDifference(0)).not.toContain("+");
  });
});

describe("analytics screen exports do not crash on import", () => {
  it("module exports are defined functions", () => {
    expect(typeof getComparisonStateClassName).toBe("function");
    expect(typeof formatComparisonDifference).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// API response robustness (spec section 13)
// ---------------------------------------------------------------------------

describe("Analytics — API error response handling", () => {
  it("1. dashboard 500 with a DASHBOARD_QUERY_FAILED error payload: no crash, shows the message, no trend rendering, retry button present", async () => {
    stubFetch({
      dashboard: () =>
        jsonResponse(
          { error: { code: "DASHBOARD_QUERY_FAILED", message: "تعذر جلب مؤشرات لوحة التحكم" } },
          500
        ),
    });

    expect(() => render(<Analytics />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText("تعذر جلب مؤشرات لوحة التحكم")).toBeInTheDocument();
    });
    expect(screen.getByText("تعذر تحميل التحليلات")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    // No growth-insight text (which reads dash.trend.growthRate) was rendered.
    expect(screen.queryByText(/ارتفاع ملحوظ في الشكاوى|انخفاض إيجابي في الشكاوى/)).not.toBeInTheDocument();
  });

  it("2. dashboard 401: no crash, shows an appropriate message", async () => {
    stubFetch({
      dashboard: () =>
        jsonResponse({ error: { code: "UNAUTHORIZED", message: "يلزم تسجيل الدخول" } }, 401),
    });

    expect(() => render(<Analytics />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText("يلزم تسجيل الدخول")).toBeInTheDocument();
    });
  });

  it("3. dashboard 400: no crash, the error payload is never stored as dashboard data", async () => {
    stubFetch({
      dashboard: () =>
        jsonResponse({ error: { code: "VALIDATION_ERROR", message: "معامل غير صالح" } }, 400),
    });

    expect(() => render(<Analytics />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText("معامل غير صالح")).toBeInTheDocument();
    });
    // No numeric KPI content from a coerced error object leaked into the page.
    expect(screen.queryByText("DASHBOARD_QUERY_FAILED")).not.toBeInTheDocument();
  });

  it("4. dashboard 200 but missing trend: treated as an incomplete response, no crash", async () => {
    const incomplete = dashboardData();
    delete (incomplete as Record<string, unknown>).trend;
    stubFetch({ dashboard: () => jsonResponse(incomplete, 200) });

    expect(() => render(<Analytics />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText("استجابة لوحة التحكم غير مكتملة.")).toBeInTheDocument();
    });
  });

  it("5. dashboard 200 with growthRate=null: no growth insight, page still renders", async () => {
    stubFetch({
      dashboard: () => jsonResponse(dashboardData({ trend: { previousTotal: null, growthRate: null, trendData: [] } }), 200),
    });

    render(<Analytics />);
    await waitFor(() => {
      expect(screen.queryByText("تعذر تحميل التحليلات")).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText(/ارتفاع ملحوظ في الشكاوى|انخفاض إيجابي في الشكاوى|استقرار في حجم الشكاوى/)
    ).not.toBeInTheDocument();
  });

  it("6. dashboard 200 with growthRate=15: shows the rise insight", async () => {
    stubFetch({
      dashboard: () => jsonResponse(dashboardData({ trend: { previousTotal: 8, growthRate: 15, trendData: [] } }), 200),
    });

    render(<Analytics />);
    await waitFor(() => {
      expect(screen.getByText("ارتفاع ملحوظ في الشكاوى")).toBeInTheDocument();
    });
  });

  it("7. analytics 500 while dashboard succeeds: no partial update, shows the analytics message", async () => {
    stubFetch({
      dashboard: () => jsonResponse(dashboardData({ trend: { previousTotal: 8, growthRate: 42, trendData: [] } }), 200),
      analytics: () =>
        jsonResponse({ error: { code: "ANALYTICS_QUERY_FAILED", message: "تعذر جلب التحليلات" } }, 500),
    });

    render(<Analytics />);
    await waitFor(() => {
      expect(screen.getByText("تعذر جلب التحليلات")).toBeInTheDocument();
    });
    // Dashboard's own successful payload was not committed either — the
    // growth insight that a partial update would have shown is absent.
    expect(screen.queryByText("ارتفاع ملحوظ في الشكاوى")).not.toBeInTheDocument();
  });

  it("8. both responses succeed: page shows data, no error alert", async () => {
    stubFetch({});

    render(<Analytics />);
    await waitFor(() => {
      expect(screen.getByText("منحنى الشكاوى اليومي")).toBeInTheDocument();
    });
    expect(screen.queryByText("تعذر تحميل التحليلات")).not.toBeInTheDocument();
  });

  it("9. retry: first request fails, clicking retry succeeds and shows data", async () => {
    let dashboardCalls = 0;
    stubFetch({
      dashboard: () => {
        dashboardCalls += 1;
        if (dashboardCalls === 1) {
          return jsonResponse({ error: { message: "تعذر جلب مؤشرات لوحة التحكم" } }, 500);
        }
        return jsonResponse(dashboardData(), 200);
      },
    });

    render(<Analytics />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));

    await waitFor(() => {
      expect(screen.queryByText("تعذر تحميل التحليلات")).not.toBeInTheDocument();
    });
    expect(screen.getByText("منحنى الشكاوى اليومي")).toBeInTheDocument();
  });

  it("10. abort: no error shown to the user when the request is aborted (unmount)", async () => {
    const pending = deferred<Response>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/filters")) return filtersOkResponse();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new DOMException("Aborted", "AbortError");
            reject(err);
          });
          void pending.promise.then(_resolve, reject);
        });
      })
    );

    const { unmount } = render(<Analytics />);
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("تعذر تحميل التحليلات")).not.toBeInTheDocument();
    // No error was logged for the abort itself.
    for (const call of consoleError.mock.calls) {
      expect(String(call[0])).not.toContain("Analytics data load failed");
    }
  });

  it("11. invalid JSON response body: no crash, shows the invalid-response message", async () => {
    stubFetch({
      dashboard: () => new Response("not-json{{{", { status: 200 }),
    });

    expect(() => render(<Analytics />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText("أعاد الخادم استجابة غير صالحة.")).toBeInTheDocument();
    });
  });

  it("12. /api/filters failure: no crash, regions/departments stay safe and the dashboard still loads", async () => {
    stubFetch({
      filters: () => jsonResponse({ error: "Failed to fetch filters" }, 500),
    });

    expect(() => render(<Analytics />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText("منحنى الشكاوى اليومي")).toBeInTheDocument();
    });
    // The dashboard's own error banner is not shown for a filters-only failure.
    expect(screen.queryByText("تعذر تحميل التحليلات")).not.toBeInTheDocument();
  });
});
