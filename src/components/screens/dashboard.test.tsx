import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function dashboardData(total: number) {
  return {
    volume: {
      total,
      open: 1,
      inProgress: 1,
      closed: 1,
      reopened: 0,
      rejected: 0,
      late: 0,
      repeated: 0,
      validated: 1,
      notValidated: 0,
      potentialDuplicates: 0,
    },
    performance: {
      closureRate: 50,
      onTimeRate: 75,
      lateRate: 25,
      avgFirstResponseHours: 2,
      avgProcessingHours: 4,
      avgOpenAgeHours: 6,
      overdueNoAction: 0,
      overdueNoActionRate: 0,
      reopenRate: 0,
      validityRate: 100,
      avgSatisfaction: 4,
      satisfactionRate: 80,
    },
    trend: {
      previousTotal: null,
      growthRate: null,
      trendData: [{ date: "2026-07-29", total, closed: 1 }],
    },
    distributions: {
      byRegion: [{ name: "الرياض", count: total }],
      byDepartment: [{ name: "الطوارئ", count: total }],
      byClassification: [{ name: "الخدمة", count: total }],
      byChannel: [{ name: "هاتف", count: total }],
      byStatus: [{ name: "open", count: 1 }],
      byPriority: [{ name: "critical", count: 1 }],
      bySeverity: [{ name: "critical", count: 1 }],
    },
    alerts: {
      criticalComplaints: 0,
      lateCritical: 0,
      missingFields: 0,
      dataQualityRate: 100,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Dashboard smoke", () => {
  it("shows loading skeletons while dashboard data is loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    const { container } = render(<Dashboard onNavigate={vi.fn()} />);

    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("aborts the in-flight dashboard request on cleanup", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<Dashboard onNavigate={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;

    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("ignores AbortError without logging a user-visible load error", async () => {
    const abortError = new DOMException("Request aborted", "AbortError");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(abortError)));

    render(<Dashboard onNavigate={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not let an old unmounted response replace the latest dashboard state", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);

    const firstRender = render(<Dashboard onNavigate={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    firstRender.unmount();
    render(<Dashboard onNavigate={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      second.resolve({ json: () => Promise.resolve(dashboardData(98_765)) } as Response);
      await second.promise;
    });

    expect(await screen.findAllByText("٩٨٬٧٦٥")).not.toHaveLength(0);

    await act(async () => {
      first.resolve({ json: () => Promise.resolve(dashboardData(12_345)) } as Response);
      await first.promise;
    });

    expect(screen.queryAllByText("١٢٬٣٤٥")).toHaveLength(0);
    expect(screen.getAllByText("٩٨٬٧٦٥")).not.toHaveLength(0);
  });
});
