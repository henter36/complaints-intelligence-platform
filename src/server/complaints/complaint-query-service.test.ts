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

    expect(where.dueDate).toEqual({ lte: new Date("2026-07-31") });
    expect(where.AND).toEqual([{ dueDate: { not: null } }]);
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
});
