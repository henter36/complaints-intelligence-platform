import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextRisks } from "./text-risks";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function makeSignalItem(overrides: Partial<{
  id: string;
  reviewStatus: string;
  severity: string;
  signalType: string;
  title: string;
  complaintId: string;
  ruleId: string;
  ruleVersion: string;
  confidenceScore: number;
  certainty: string;
  isOngoing: boolean | null;
  evidenceSpans: unknown[];
  region: string | null;
  facility: string | null;
  department: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewReason: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "sig-1",
    reviewStatus: overrides.reviewStatus ?? "PENDING_REVIEW",
    severity: overrides.severity ?? "HIGH",
    signalType: overrides.signalType ?? "POISONING",
    title: overrides.title ?? "إشارة اختبار",
    complaintId: overrides.complaintId ?? "cmp-1",
    ruleId: overrides.ruleId ?? "rule-1",
    ruleVersion: overrides.ruleVersion ?? "v1",
    confidenceScore: overrides.confidenceScore ?? 0.9,
    certainty: overrides.certainty ?? "SUSPECTED",
    isOngoing: overrides.isOngoing ?? null,
    evidenceSpans: overrides.evidenceSpans ?? [],
    region: overrides.region ?? null,
    facility: overrides.facility ?? null,
    department: overrides.department ?? null,
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
    reviewedAt: overrides.reviewedAt ?? null,
    reviewReason: overrides.reviewReason ?? null,
  };
}

function makeListResult(items: ReturnType<typeof makeSignalItem>[], total?: number) {
  return { items, total: total ?? items.length, page: 1, pageSize: 20 };
}

function makeOkResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TextRisks screen", () => {
  it("shows loading skeleton after first fetch fires", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const { container } = render(<TextRisks />);
    // Loading is false on first paint; fetchData is deferred one microtask
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("renders pending count label 'قيد المراجعة في الصفحة الحالية'", async () => {
    const items = [
      makeSignalItem({ id: "s1", reviewStatus: "PENDING_REVIEW" }),
      makeSignalItem({ id: "s2", reviewStatus: "PENDING_REVIEW" }),
      makeSignalItem({ id: "s3", reviewStatus: "CONFIRMED" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeOkResponse(makeListResult(items))))
    );

    render(<TextRisks />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("قيد المراجعة في الصفحة الحالية")).toBeInTheDocument();
  });

  it("does not let an old response overwrite a newer response (request race)", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();

    const oldItems = [makeSignalItem({ id: "old-sig", title: "إشارة قديمة" })];
    const newItems = [makeSignalItem({ id: "new-sig", title: "إشارة جديدة" })];

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount++;
        return callCount === 1 ? first.promise : second.promise;
      })
    );

    render(<TextRisks />);
    // First fetch starts
    await act(async () => { await Promise.resolve(); });

    // Click the refresh button to trigger a second fetch
    const refreshBtn = screen.getByRole("button", { name: "تحديث القائمة" });
    await act(async () => { fireEvent.click(refreshBtn); });

    // Resolve the newer (second) fetch first
    await act(async () => {
      second.resolve(makeOkResponse(makeListResult(newItems)));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Then resolve the older (first) fetch — should be ignored
    await act(async () => {
      first.resolve(makeOkResponse(makeListResult(oldItems)));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Old data must not appear
    expect(screen.queryByText("إشارة قديمة")).not.toBeInTheDocument();
  });

  it("aborts in-flight request on unmount", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<TextRisks />);
    await act(async () => { await Promise.resolve(); });

    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
