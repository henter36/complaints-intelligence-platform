import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getOperationalAnalytics = vi.fn();

vi.mock("@/server/analytics/operational/operational-analytics-service", () => ({
  getOperationalAnalytics,
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: vi.fn().mockResolvedValue({ id: "session_test", username: "admin" }),
  mapAuthError: vi.fn().mockReturnValue(null),
}));

describe("GET /api/analytics/operational", () => {
  beforeEach(() => {
    getOperationalAnalytics.mockReset();
  });

  it("returns the operational analytics JSON shape and never enables staff actors", async () => {
    getOperationalAnalytics.mockResolvedValue({
      totalInScope: 3,
      generatedAt: "2026-08-05T12:00:00.000Z",
      timezoneDisplay: "Asia/Riyadh",
      sourceOrigin: { items: [], total: 3 },
      sourceStatus: { items: [], total: 3, unspecifiedCount: 0 },
      sourceActionStatus: { items: [], total: 3, unspecifiedCount: 0 },
      channelIndependentCheck: {
        sourceOriginKeys: 1,
        channelKeys: 1,
        note: "sourceOrigin and channel are independent dimensions; do not merge.",
      },
      actionTakenQuality: {
        nonEmptyCount: 0,
        emptyCount: 3,
        uniqueCount: 0,
        topNormalized: [],
        rareValueShare: 0,
        longTextShare: 0,
        spellingVariantHints: [],
      },
      wing: { items: [], unspecifiedCount: 0, total: 3 },
      freshness: {
        lastSourceUpdatedAt: null,
        lastSourceUpdatedAtRiyadh: null,
        oldestSourceUpdatedAt: null,
        oldestSourceUpdatedAtRiyadh: null,
        averageAgeDays: null,
        freshShare: 0,
        staleShare: 0,
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
        sourceOrigin: 1,
        sourceStatus: 1,
        sourceActionStatus: 1,
        wingCode: 1,
        freshness: 1,
        actionTakenQuality: 1,
        dataQuality: 1,
      },
    });

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost/api/analytics/operational?includeStaffActors=true")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.totalInScope).toBe(3);
    expect(body.timezoneDisplay).toBe("Asia/Riyadh");
    expect(body.staffActors.enabled).toBe(false);
    expect(body.performanceMs).toMatchObject({ loadRows: 1 });
    expect(getOperationalAnalytics).toHaveBeenCalledWith(expect.any(URLSearchParams), {
      includeStaffActors: false,
    });
    expect(JSON.stringify(body)).not.toContain("AhmedAli");
  });
});
