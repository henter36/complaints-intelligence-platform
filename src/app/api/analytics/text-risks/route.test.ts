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

  it("returns 200 for a request with no filters", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
  });

  it("returns 200 for valid signalType enum value", async () => {
    const res = await get("?signalType=POISONING");
    expect(res.status).toBe(200);
  });

  it("returns 200 when from equals to", async () => {
    const res = await get("?from=2026-07-01&to=2026-07-01");
    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid signalType enum", async () => {
    const res = await get("?signalType=NOT_A_VALID_TYPE");
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid severity enum", async () => {
    const res = await get("?severity=BAD_SEVERITY");
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid reviewStatus enum", async () => {
    const res = await get("?reviewStatus=NOT_VALID");
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid certainty enum", async () => {
    const res = await get("?certainty=MADE_UP");
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid date format in from", async () => {
    const res = await get("?from=not-a-date");
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid date format in to", async () => {
    const res = await get("?to=definitely-not-a-date");
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is after to", async () => {
    const res = await get("?from=2026-07-31&to=2026-07-01");
    expect(res.status).toBe(400);
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
