import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OperationalAnalyticsPanel,
  readJsonResponse,
} from "./operational-analytics-panel";
import type { OperationalAnalyticsSummary } from "@/server/analytics/operational/operational-analytics-types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSummary(overrides: Partial<OperationalAnalyticsSummary> = {}): OperationalAnalyticsSummary {
  return {
    totalInScope: 10,
    generatedAt: "2026-08-05T12:00:00.000Z",
    timezoneDisplay: "Asia/Riyadh",
    sourceOrigin: { items: [], total: 10 },
    sourceStatus: { items: [], total: 10, unspecifiedCount: 0 },
    sourceActionStatus: { items: [], total: 10, unspecifiedCount: 0 },
    channelIndependentCheck: {
      sourceOriginKeys: 1,
      channelKeys: 1,
      note: "sourceOrigin and channel are independent dimensions; do not merge.",
    },
    actionTakenQuality: {
      nonEmptyCount: 0,
      emptyCount: 10,
      uniqueCount: 0,
      rareValueShare: 0,
      longTextShare: 0,
      spellingVariantHints: [],
      topNormalized: [],
    },
    wing: { items: [], unspecifiedCount: 0, total: 0 },
    freshness: {
      lastSourceUpdatedAt: null,
      lastSourceUpdatedAtRiyadh: null,
      oldestSourceUpdatedAt: null,
      oldestSourceUpdatedAtRiyadh: null,
      averageAgeDays: 0,
      freshShare: 40,
      staleShare: 60,
      buckets: [],
      missingUpdatedAt: 0,
      missingModifiedAt: 0,
      modifiedBeforeUpdated: 0,
      updatedVsModifiedDiffHoursAvg: null,
    },
    dataQuality: [],
    staffActors: {
      enabled: false,
      reason: "عرض المستخدمين التشغيليين معطّل افتراضيًا بانتظار صلاحية مصرّحة",
      emptyClosedBy: 0,
      emptyUpdatedBy: 0,
    },
    performanceMs: {
      loadRows: 1,
      previousPeriod: 0,
      sourceOrigin: 0,
      sourceStatus: 0,
      sourceActionStatus: 0,
      wingCode: 0,
      freshness: 0,
      actionTakenQuality: 0,
      dataQuality: 0,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readJsonResponse", () => {
  it("returns JSON for 200", async () => {
    const payload = { ok: true };
    const result = await readJsonResponse<typeof payload>(
      new Response(JSON.stringify(payload), { status: 200 })
    );
    expect(result).toEqual(payload);
  });

  it("throws sanitized message for 400", async () => {
    await expect(
      readJsonResponse(
        new Response(JSON.stringify({ error: { message: "معاملات غير صالحة" } }), { status: 400 })
      )
    ).rejects.toThrow("معاملات غير صالحة");
  });

  it("throws status fallback for invalid JSON on error", async () => {
    await expect(readJsonResponse(new Response("not-json", { status: 500 }))).rejects.toThrow(
      "Request failed with status 500"
    );
  });
});

describe("OperationalAnalyticsPanel HTTP handling", () => {
  it("stores OperationalAnalyticsSummary on 200", async () => {
    const summary = makeSummary({ totalInScope: 42 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/api/filters")) {
          return new Response(JSON.stringify({ sourceOrigins: [], dataFreshnessBuckets: [] }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify(summary), { status: 200 });
      })
    );

    render(<OperationalAnalyticsPanel from="" to="" regionId="all" departmentId="all" />);
    await waitFor(() => {
      expect(screen.getByText("نطاق التحليل")).toBeInTheDocument();
    });
    expect(screen.getByText("٤٢")).toBeInTheDocument();
  });

  it("shows 400 message without TypeError on data.freshness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/api/filters")) {
          return new Response(JSON.stringify({ sourceOrigins: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ error: { code: "BAD", message: "طلب غير صالح" } }),
          { status: 400 }
        );
      })
    );

    render(<OperationalAnalyticsPanel from="" to="" regionId="all" departmentId="all" />);
    await waitFor(() => {
      expect(screen.getByText("طلب غير صالح")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
  });

  it("shows 500 message without TypeError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).includes("/api/filters")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response(
          JSON.stringify({ error: { message: "تعذر جلب التحليلات التشغيلية" } }),
          { status: 500 }
        );
      })
    );

    render(<OperationalAnalyticsPanel from="" to="" regionId="all" departmentId="all" />);
    await waitFor(() => {
      expect(screen.getByText("تعذر جلب التحليلات التشغيلية")).toBeInTheDocument();
    });
  });

  it("handles invalid JSON error bodies safely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).includes("/api/filters")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response("{broken", { status: 500 });
      })
    );

    render(<OperationalAnalyticsPanel from="" to="" regionId="all" departmentId="all" />);
    await waitFor(() => {
      expect(screen.getByText(/Request failed with status 500/)).toBeInTheDocument();
    });
  });

  it("does not show an error when the request is aborted", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        if (String(input).includes("/api/filters")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
          void pending.promise.then(_resolve, reject);
        });
      })
    );

    const { unmount } = render(
      <OperationalAnalyticsPanel from="" to="" regionId="all" departmentId="all" />
    );
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    expect(screen.queryByText(/تعذر|Request failed/)).not.toBeInTheDocument();
  });

  it("does not let an older request replace a newer one", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let analyticsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).includes("/api/filters")) {
          return new Response(JSON.stringify({ dataFreshnessBuckets: [] }), { status: 200 });
        }
        analyticsCalls += 1;
        if (analyticsCalls === 1) return first.promise;
        return second.promise;
      })
    );

    const { rerender } = render(
      <OperationalAnalyticsPanel from="2026-01-01" to="2026-01-31" regionId="all" departmentId="all" />
    );
    await act(async () => {
      await Promise.resolve();
    });

    rerender(
      <OperationalAnalyticsPanel from="2026-02-01" to="2026-02-28" regionId="all" departmentId="all" />
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    second.resolve(new Response(JSON.stringify(makeSummary({ totalInScope: 2 })), { status: 200 }));
    await waitFor(() => {
      expect(screen.getByText("٢")).toBeInTheDocument();
    });

    first.resolve(new Response(JSON.stringify(makeSummary({ totalInScope: 1 })), { status: 200 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("٢")).toBeInTheDocument();
    expect(screen.queryByText("١")).not.toBeInTheDocument();
  });

  it("does not silently turn filter failures into empty options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).includes("/api/filters")) {
          return new Response(
            JSON.stringify({ error: { message: "filters down" } }),
            { status: 500 }
          );
        }
        return new Response(JSON.stringify(makeSummary()), { status: 200 });
      })
    );

    render(<OperationalAnalyticsPanel from="" to="" regionId="all" departmentId="all" />);
    await waitFor(() => {
      expect(screen.getByText("تعذر تحميل خيارات الفلاتر.")).toBeInTheDocument();
    });
    expect(screen.queryByText("filters down")).not.toBeInTheDocument();
  });
});
