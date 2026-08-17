import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getComparisonStateClassName,
  formatComparisonDifference,
  Analytics,
} from "./analytics";
import type { AnalyticsData, DashboardData } from "@/lib/analytics/analytics-api-contract";
import { makeAnalyticsData, makeDashboardData } from "@/lib/analytics/analytics-api-fixtures";
import type { AnalyticalFinding } from "@/lib/analytics/analytical-finding";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function dashboardData(overrides: Partial<DashboardData> = {}) {
  return makeDashboardData(overrides);
}

function analyticsData(overrides: Partial<AnalyticsData> = {}) {
  return makeAnalyticsData(overrides);
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

  it("rejects a dashboard-shaped payload when the HTTP status is 400", async () => {
    // response.ok is a gate independent of the JSON shape: even a body that
    // fully matches DashboardData (and would produce a visible growth
    // insight if stored) must be rejected on a 400 status, not on shape.
    const rejectedDashboard = {
      ...dashboardData({
        trend: {
          previousTotal: 8,
          growthRate: 42,
          trendData: [],
        },
      }),
      error: {
        code: "VALIDATION_ERROR",
        message: "معامل غير صالح",
      },
    };
    stubFetch({
      dashboard: () => jsonResponse(rejectedDashboard, 400),
    });

    expect(() => render(<Analytics />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText("معامل غير صالح")).toBeInTheDocument();
    });
    expect(screen.getByText("تعذر تحميل التحليلات")).toBeInTheDocument();
    // If the payload had been stored as dashboard state despite the 400,
    // growthRate: 42 would have produced this insight — its absence proves
    // the rejected body never reached state.
    expect(screen.queryByText("ارتفاع ملحوظ في الشكاوى")).not.toBeInTheDocument();
    // The raw error code must not leak into the UI either.
    expect(screen.queryByText("VALIDATION_ERROR")).not.toBeInTheDocument();
  });

  it("4. dashboard 200 but missing trend: treated as an incomplete response, no crash", async () => {
    const incomplete = dashboardData();
    delete (incomplete as unknown as Record<string, unknown>).trend;
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

  it("10. abort: a superseded request (period changed while the first request is pending) is aborted, and the still-mounted page shows the second request's data with no error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firstDashboardPending = deferred<Response>();
    let firstDashboardSignal: AbortSignal | null | undefined;
    let dashboardCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/filters")) return filtersOkResponse();

        if (url.includes("/api/dashboard")) {
          dashboardCallCount += 1;
          if (dashboardCallCount === 1) {
            firstDashboardSignal = init?.signal;
            return new Promise<Response>((resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("Aborted", "AbortError"));
              });
              void firstDashboardPending.promise.then(resolve, reject);
            });
          }
          return jsonResponse(dashboardData(), 200);
        }

        if (url.includes("/api/analytics")) {
          return new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
            resolve(jsonResponse(analyticsData(), 200));
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      })
    );

    render(<Analytics />);

    await waitFor(() => {
      expect(firstDashboardSignal).toBeDefined();
    });
    expect(firstDashboardSignal?.aborted).toBe(false);

    // Change the period while the first request is still pending — this
    // supersedes it: the effect's cleanup aborts the in-flight request and
    // starts a new one for the new query.
    await userEvent.click(screen.getByRole("button", { name: "آخر 30 يوم" }));

    await waitFor(() => {
      expect(screen.getByText("منحنى الشكاوى اليومي")).toBeInTheDocument();
    });

    expect(firstDashboardSignal?.aborted).toBe(true);
    expect(screen.queryByText("تعذر تحميل التحليلات")).not.toBeInTheDocument();
    for (const call of consoleError.mock.calls) {
      expect(String(call[0])).not.toContain("Analytics data load failed");
    }
  });

  it("10b. abort on unmount: no error is logged for the cancellation itself", async () => {
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

    // Not asserted via the DOM (the tree is torn down after unmount) — an
    // abort triggered by unmounting must be swallowed entirely: no load
    // failure logged, no React "state update on unmounted component" or
    // unhandled-rejection warning either.
    expect(consoleError).not.toHaveBeenCalled();
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

  it("13. dashboard 200 with a malformed distributions shape: rejected as incomplete, no crash", async () => {
    const malformed = {
      ...dashboardData(),
      distributions: {
        byRegion: {}, // should be an array of {name, count}
        byDepartment: [],
        byClassification: [],
        byChannel: [],
        byStatus: [],
        byPriority: [],
        bySeverity: [],
      },
    };
    stubFetch({ dashboard: () => jsonResponse(malformed, 200) });

    expect(() => render(<Analytics />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText("استجابة لوحة التحكم غير مكتملة.")).toBeInTheDocument();
    });
  });

  it("14. analytics 200 with a malformed anomalies shape: rejected as incomplete, no crash", async () => {
    const malformed = {
      ...analyticsData(),
      anomalies: {
        regions: {}, // should be an array of anomaly items
        departments: [],
        classifications: [],
      },
    };
    stubFetch({ analytics: () => jsonResponse(malformed, 200) });

    expect(() => render(<Analytics />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText("استجابة التحليلات غير مكتملة.")).toBeInTheDocument();
    });
  });
});

describe("Analytics — notes tab (pattern-analysis findings)", () => {
  function chronicFinding(): AnalyticalFinding {
    return {
      id: "chronic_issue:سجن أ:cls-1:2026-01-01",
      type: "CHRONIC_ISSUE",
      entityType: "CLASSIFICATION",
      entityId: "cls-1",
      entityName: "سجن أ — التغذية",
      currentValue: 46,
      previousValue: 43,
      difference: 3,
      changeRate: 7,
      severity: "HIGH",
      priorityScore: 78,
      confidence: "HIGH",
      detectionSource: "QUANTITATIVE",
      explanation: "مشكلة مزمنة بسبب: استمرار 5 فترات",
      supportingMetrics: {
        streakPeriods: 5,
        repeatRatePercent: 18.4,
        facilitySharePercent: 29,
        periodCounts: JSON.stringify([8, 9, 8, 9, 46]),
        priorityReasons: JSON.stringify(["استمرار 5 فترات", "معدل تكرار مرتفع"]),
      },
      evidenceComplaintIds: [],
      evidenceSpans: [],
      limitations: [],
      drilldownFilters: { facility: "سجن أ", classificationId: "cls-1", from: "2026-01-01", to: "2026-01-31" },
      firstDetectedAt: "2026-01-31T00:00:00.000Z",
      lastDetectedAt: "2026-01-31T00:00:00.000Z",
      detectorVersion: "pattern-v1",
    };
  }

  it("renders the finding's own priority reasons and drills down with the right query", async () => {
    stubFetch({ analytics: () => jsonResponse(analyticsData({ findings: [chronicFinding()] }), 200) });
    const onNavigateToExplorer = vi.fn();
    const user = userEvent.setup();

    render(<Analytics onNavigateToExplorer={onNavigateToExplorer} />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /الملاحظات/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("tab", { name: /الملاحظات/ }));

    await waitFor(() => {
      expect(screen.getByText("سجن أ — التغذية")).toBeInTheDocument();
    });
    expect(screen.getByText("استمرار 5 فترات")).toBeInTheDocument();
    expect(screen.getByText("معدل تكرار مرتفع")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "عرض الشكاوى المرتبطة" }));
    expect(onNavigateToExplorer).toHaveBeenCalledWith({
      facility: "سجن أ",
      classificationId: "cls-1",
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("shows the empty-state message when there are no findings", async () => {
    stubFetch({ analytics: () => jsonResponse(analyticsData({ findings: [] }), 200) });
    const user = userEvent.setup();

    render(<Analytics />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /الملاحظات/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("tab", { name: /الملاحظات/ }));

    await waitFor(() => {
      expect(screen.getByText("لا توجد ملاحظات تحليلية للفترة والفلاتر الحالية.")).toBeInTheDocument();
    });
  });
});
