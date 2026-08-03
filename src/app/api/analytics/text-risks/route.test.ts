import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listSignalsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: vi.fn().mockResolvedValue({}),
  mapAuthError: vi.fn().mockReturnValue(null),
}));
vi.mock("@/server/analytics/text-risk/text-risk-analysis-service", () => ({
  listTextRiskSignals: listSignalsMock,
}));

const EMPTY_RESULT = { items: [], total: 0, page: 1, pageSize: 20 };

async function get(search: string) {
  const { GET } = await import("./route");
  return GET(new NextRequest(`http://localhost/api/analytics/text-risks${search}`));
}

describe("GET /api/analytics/text-risks", () => {
  beforeEach(() => {
    listSignalsMock.mockResolvedValue(EMPTY_RESULT);
  });

  it.each([
    ["طلب دون فلاتر", ""],
    ["signalType صالح", "?signalType=POISONING"],
    ["from يساوي to", "?from=2026-07-01&to=2026-07-01"],
  ])("valid: %s → 200", async (_name, search) => {
    const res = await get(search);
    expect(res.status).toBe(200);
  });

  it.each([
    ["signalType غير صالح", "?signalType=NOT_A_VALID_TYPE"],
    ["severity غير صالح", "?severity=BAD_SEVERITY"],
    ["reviewStatus غير صالح", "?reviewStatus=NOT_VALID"],
    ["certainty غير صالح", "?certainty=MADE_UP"],
    ["from غير صالح", "?from=not-a-date"],
    ["to غير صالح", "?to=definitely-not-a-date"],
    ["from بعد to", "?from=2026-07-31&to=2026-07-01"],
  ])("%s يعيد INVALID_QUERY", async (_name, search) => {
    const res = await get(search);
    const body = await res.json() as { error: { code: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_QUERY");
  });

  it("passes parsed filters to listTextRiskSignals", async () => {
    await get("?signalType=POISONING&page=2&pageSize=10");
    expect(listSignalsMock).toHaveBeenCalledWith(
      expect.objectContaining({ signalType: "POISONING", page: 2, pageSize: 10 })
    );
  });

  it("returns 500 when listTextRiskSignals throws", async () => {
    listSignalsMock.mockRejectedValueOnce(new Error("db failure"));
    const res = await get("");
    expect(res.status).toBe(500);
  });
});
