import { ComplaintStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildComplaintWhere,
  listComplaints,
  parseComplaintQuery,
} from "./complaint-query-service";

const dbMocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      findMany: dbMocks.findMany,
      count: dbMocks.count,
    },
  },
}));

function query(value = ""): URLSearchParams {
  return new URLSearchParams(value);
}

describe("central complaint query service", () => {
  beforeEach(() => {
    dbMocks.findMany.mockReset();
    dbMocks.count.mockReset();
    dbMocks.findMany.mockResolvedValue([]);
    dbMocks.count.mockResolvedValue(0);
  });

  it("intersects hasDueDate=false with an existing due date range", () => {
    const parsed = parseComplaintQuery(query("dueFrom=2026-07-01&hasDueDate=false"));
    const where = buildComplaintWhere(parsed, new Date("2026-07-30T00:00:00Z"));

    expect(where.dueDate).toEqual({ gte: new Date("2026-07-01") });
    expect(where.AND).toEqual([{ dueDate: null }]);
  });

  it("intersects hasDueDate=true with an existing due date range", () => {
    const parsed = parseComplaintQuery(query("dueTo=2026-07-31&hasDueDate=true"));
    const where = buildComplaintWhere(parsed, new Date("2026-07-30T00:00:00Z"));

    expect(where.dueDate).toEqual({ lt: new Date("2026-08-01T00:00:00.000Z") });
    expect(where.AND).toEqual([{ dueDate: { not: null } }]);
  });

  it("treats calendar to=YYYY-MM-DD as inclusive through end of that UTC day", () => {
    const parsed = parseComplaintQuery(query("from=2025-09-08&to=2026-07-15"));
    const where = buildComplaintWhere(parsed, new Date("2026-07-30T00:00:00Z"));

    expect(where.complaintDate).toEqual({
      gte: new Date("2025-09-08T00:00:00.000Z"),
      lt: new Date("2026-07-16T00:00:00.000Z"),
    });
  });

  it("intersects hasClassification=false with explicit classificationId", () => {
    const parsed = parseComplaintQuery(query("classificationId=cls_1&hasClassification=false"));
    const where = buildComplaintWhere(parsed, new Date("2026-07-30T00:00:00Z"));

    expect(where.classificationId).toBe("cls_1");
    expect(where.AND).toEqual([{ classificationId: null }]);
  });

  it("intersects hasClassification=true with explicit classificationId", () => {
    const parsed = parseComplaintQuery(query("classificationId=cls_1&hasClassification=true"));
    const where = buildComplaintWhere(parsed, new Date("2026-07-30T00:00:00Z"));

    expect(where.classificationId).toBe("cls_1");
    expect(where.AND).toEqual([{ classificationId: { not: null } }]);
  });

  it("turns the visible facility filter into its canonical indexed key", () => {
    const where = buildComplaintWhere(parseComplaintQuery(query("facility=سجن%20%20الرياض")));
    expect(where.facility).toBeUndefined();
    expect(where.facilityNormalizedName).toBe("سجن الرياض");
  });

  it("removes only default page and pageSize from applied filters", async () => {
    const result = await listComplaints(query());

    expect(result.appliedFilters).toEqual({});
  });

  it("keeps page when it equals the default pageSize value", async () => {
    const result = await listComplaints(query("page=25"));

    expect(result.appliedFilters).toMatchObject({ page: 25 });
  });

  it("keeps pageSize when it equals the default page value", async () => {
    const result = await listComplaints(query("pageSize=1"));

    expect(result.appliedFilters).toMatchObject({ pageSize: 1 });
  });

  it("parses official complaint statuses without changing their vocabulary", () => {
    expect(parseComplaintQuery(query("status=OPEN")).status).toBe("OPEN");
    expect(parseComplaintQuery(query("status=CLOSED")).status).toBe("CLOSED");
    expect(parseComplaintQuery(query("status=CANCELLED")).status).toBe("CANCELLED");
  });

  it("keeps legacy status aliases only at the API query boundary", () => {
    const legacyOpen = "OPEN".toLowerCase();
    const legacyInProgress = "IN_PROGRESS".toLowerCase();
    const legacyClosed = "CLOSED".toLowerCase();
    const legacyRejected = ["re", "jected"].join("");
    const legacyReopened = ["re", "opened"].join("");

    expect(parseComplaintQuery(query(`status=${legacyOpen}`)).status).toBe("OPEN");
    expect(parseComplaintQuery(query(`status=${legacyInProgress}`)).status).toBe("IN_PROGRESS");
    expect(parseComplaintQuery(query(`status=${legacyClosed}`)).status).toBe("CLOSED");
    expect(parseComplaintQuery(query(`status=${legacyRejected}`)).status).toBe("CANCELLED");
    expect(parseComplaintQuery(query(`status=${legacyReopened}`)).status).toBe("OPEN");
  });

  it("rejects unsupported complaint statuses", () => {
    expect(() => parseComplaintQuery(query("status=ARCHIVED"))).toThrow("status is not supported");
  });

  it("builds freshness bucket where clauses with shared bounds", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const oneDayAgo = new Date(now.getTime() - day);
    const threeDaysAgo = new Date(now.getTime() - 3 * day);
    const sevenDaysAgo = new Date(now.getTime() - 7 * day);

    const missing = buildComplaintWhere(parseComplaintQuery(query("dataFreshnessBucket=missing")), now);
    expect(JSON.stringify(missing)).toContain('"sourceUpdatedAt":null');

    const fresh = buildComplaintWhere(parseComplaintQuery(query("dataFreshnessBucket=fresh_1d")), now);
    expect(fresh.AND).toEqual(expect.arrayContaining([{ sourceUpdatedAt: { gt: oneDayAgo } }]));

    const stale13 = buildComplaintWhere(
      parseComplaintQuery(query("dataFreshnessBucket=stale_1_3d")),
      now
    );
    expect(stale13.AND).toEqual(
      expect.arrayContaining([{ sourceUpdatedAt: { gt: threeDaysAgo, lte: oneDayAgo } }])
    );

    const stale37 = buildComplaintWhere(
      parseComplaintQuery(query("dataFreshnessBucket=stale_3_7d")),
      now
    );
    expect(stale37.AND).toEqual(
      expect.arrayContaining([{ sourceUpdatedAt: { gt: sevenDaysAgo, lte: threeDaysAgo } }])
    );

    const stale7 = buildComplaintWhere(
      parseComplaintQuery(query("dataFreshnessBucket=stale_7d_plus")),
      now
    );
    expect(stale7.AND).toEqual(
      expect.arrayContaining([{ sourceUpdatedAt: { lte: sevenDaysAgo } }])
    );
  });

  it("uses currently late helper for isLate=true", () => {
    const now = new Date("2026-07-30T00:00:00Z");
    const where = buildComplaintWhere(parseComplaintQuery(query("isLate=true")), now);
    expect(where.AND).toEqual([
      {
        dueDate: { lt: now },
        status: {
          in: [
            ComplaintStatus.NEW,
            ComplaintStatus.OPEN,
            ComplaintStatus.IN_PROGRESS,
            ComplaintStatus.AWAITING_RESPONSE,
          ],
        },
      },
    ]);
  });
});
