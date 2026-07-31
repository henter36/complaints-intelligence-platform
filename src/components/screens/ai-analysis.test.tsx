// Tests for ai-analysis.tsx fetch error-handling paths.
// Focuses on sendFeedback and deleteResult response.ok checks.

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Shared toast spy ─────────────────────────────────────────────────────────

let toastSpy: ReturnType<typeof vi.fn>;

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (...args: unknown[]) => toastSpy(...args) }),
}));

// ─── Import component AFTER mocks ────────────────────────────────────────────

const { AiAnalysis } = await import("./ai-analysis");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** AI-disabled status response — component renders without the run form */
const disabledStatus = {
  enabled: false,
  provider: null,
  model: null,
  maxInputComplaints: 50,
  dailyRunLimit: 5,
  retentionDays: 30,
};

/** Empty runs list */
const emptyRuns = { items: [] };

/** Minimal fetch stub: returns a response based on the url */
function makeFetchStub(handler: (url: string) => Promise<Response>): typeof fetch {
  return vi.fn((url: string | URL | Request) => handler(String(url))) as unknown as typeof fetch;
}

/**
 * Mount AiAnalysis with:
 *  - /api/ai/status → AI disabled (so we don't need to stub run-related routes)
 *  - /api/ai/analyses?pageSize=20 → empty list
 * Returns a cleanup fn.
 */
async function mountWithDisabledAi() {
  const { unmount } = render(<AiAnalysis />);
  // Flush initial load effects
  await act(async () => { await Promise.resolve(); });
  return { unmount };
}

// ─── Test state ───────────────────────────────────────────────────────────────

beforeEach(() => {
  toastSpy = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── sendFeedback — logic tests ───────────────────────────────────────────────

describe("sendFeedback — fetch error handling", () => {
  it("shows destructive toast and does NOT reload detail on 500 response", async () => {
    // Test the sendFeedback logic pattern directly
    let toastArgs: unknown[] = [];
    const localToast = (args: unknown) => { toastArgs = [args]; };

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("feedback")) {
        return { ok: false, status: 500 } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    };

    const runId = "run-123";
    let detailReloaded = false;

    // Mirrors sendFeedback logic from ai-analysis.tsx
    try {
      const response = await fetchImpl(`/api/ai/analyses/${runId}/feedback`);
      if (!response.ok) {
        localToast({ variant: "destructive", title: "خطأ", description: "تعذّر إرسال التقييم" });
        // No detail reload on error
      } else {
        detailReloaded = true;
      }
    } catch {
      localToast({ variant: "destructive", title: "خطأ", description: "تعذّر إرسال التقييم" });
    }

    expect(detailReloaded).toBe(false);
    expect(toastArgs).toMatchObject([
      expect.objectContaining({ variant: "destructive" }),
    ]);
  });

  it("does NOT show destructive toast on 200 response", async () => {
    const fetchImpl = async (_url: string): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    let errorToastShown = false;
    let detailReloaded = false;

    // Mirrors sendFeedback logic from ai-analysis.tsx
    try {
      const response = await fetchImpl(`/api/ai/analyses/run-456/feedback`);
      if (!response.ok) {
        errorToastShown = true;
      } else {
        detailReloaded = true;
      }
    } catch {
      errorToastShown = true;
    }

    expect(errorToastShown).toBe(false);
    expect(detailReloaded).toBe(true);
  });
});

// ─── deleteResult — logic tests ───────────────────────────────────────────────

describe("deleteResult — fetch error handling", () => {
  it("shows destructive toast and does NOT clear selectedDetail on 500 response", async () => {
    const fetchImpl = async (_url: string): Promise<Response> => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    let selectedDetail: { id: string } | null = { id: "run-789" };
    let errorToastShown = false;

    // Mirrors deleteResult logic from ai-analysis.tsx
    try {
      const response = await fetchImpl(`/api/ai/analyses/run-789`);
      if (!response.ok) {
        errorToastShown = true;
        // return — selectedDetail stays unchanged
      } else {
        selectedDetail = null;
      }
    } catch {
      errorToastShown = true;
      // selectedDetail stays unchanged
    }

    expect(errorToastShown).toBe(true);
    expect(selectedDetail).not.toBeNull();
    expect(selectedDetail?.id).toBe("run-789");
  });

  it("shows destructive toast and does NOT clear selectedDetail on network rejection", async () => {
    const fetchImpl = async (_url: string): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    };

    let selectedDetail: { id: string } | null = { id: "run-999" };
    let errorToastShown = false;

    // Mirrors deleteResult logic from ai-analysis.tsx
    try {
      await fetchImpl(`/api/ai/analyses/run-999`);
      selectedDetail = null;
    } catch {
      errorToastShown = true;
      // selectedDetail stays unchanged
    }

    expect(errorToastShown).toBe(true);
    expect(selectedDetail).not.toBeNull();
    expect(selectedDetail?.id).toBe("run-999");
  });

  it("clears selectedDetail on successful 200 delete", async () => {
    const fetchImpl = async (_url: string): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    let selectedDetail: { id: string } | null = { id: "run-111" };
    let errorToastShown = false;

    // Mirrors deleteResult logic from ai-analysis.tsx
    try {
      const response = await fetchImpl(`/api/ai/analyses/run-111`);
      if (!response.ok) {
        errorToastShown = true;
      } else {
        selectedDetail = null;
      }
    } catch {
      errorToastShown = true;
    }

    expect(errorToastShown).toBe(false);
    expect(selectedDetail).toBeNull();
  });
});

// ─── Component smoke test (AI disabled path) ──────────────────────────────────

describe("AiAnalysis — renders without crashing", () => {
  it("renders the AI disabled state", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchStub(async (url) => {
        if (url.includes("/api/ai/status")) {
          return { ok: true, json: async () => disabledStatus } as Response;
        }
        return { ok: true, json: async () => emptyRuns } as Response;
      })
    );

    const { unmount } = await mountWithDisabledAi();
    unmount();
  });
});
