import { describe, expect, it } from "vitest";
import {
  addComplaintRequestFilters,
  buildComplaintWhereFromParams,
  InvalidComplaintQueryError,
} from "./complaint-query";

function params(query = "") {
  return new URLSearchParams(query);
}

describe("complaint query filters", () => {
  it("builds an unbounded base query when date filters are absent", () => {
    expect(buildComplaintWhereFromParams(params())).toEqual({ isDeleted: false });
  });

  it("accepts a valid from date only", () => {
    expect(buildComplaintWhereFromParams(params("from=2026-07-01")).complaintDate).toEqual({
      gte: new Date("2026-07-01"),
    });
  });

  it("accepts a valid to date only", () => {
    expect(buildComplaintWhereFromParams(params("to=2026-07-31")).complaintDate).toEqual({
      lte: new Date("2026-07-31"),
    });
  });

  it("accepts a valid inclusive date range", () => {
    expect(buildComplaintWhereFromParams(params("from=2026-07-01&to=2026-07-31")).complaintDate).toEqual({
      gte: new Date("2026-07-01"),
      lte: new Date("2026-07-31"),
    });
  });

  it("builds all supported base filters together", () => {
    expect(
      buildComplaintWhereFromParams(
        params(
          "from=2026-07-01&to=2026-07-31&regionId=riyadh&departmentId=er&classificationId=cls-1&channel=phone&status=OPEN&priority=HIGH&severity=CRITICAL"
        )
      )
    ).toEqual({
      isDeleted: false,
      complaintDate: {
        gte: new Date("2026-07-01"),
        lte: new Date("2026-07-31"),
      },
      region: "riyadh",
      department: "er",
      classificationId: "cls-1",
      channel: "phone",
      status: "OPEN",
      priority: "HIGH",
      severity: "CRITICAL",
    });
  });

  it("rejects an invalid from date", () => {
    expect(() => buildComplaintWhereFromParams(params("from=invalid"))).toThrow(InvalidComplaintQueryError);
  });

  it("rejects an invalid to date", () => {
    expect(() => buildComplaintWhereFromParams(params("to=invalid"))).toThrow(InvalidComplaintQueryError);
  });

  it("rejects a range where from is after to", () => {
    expect(() => buildComplaintWhereFromParams(params("from=2026-08-01&to=2026-07-31"))).toThrow(
      /before or equal/
    );
  });

  it("rejects unsupported status values", () => {
    expect(() => buildComplaintWhereFromParams(params("status=NOT_REAL"))).toThrow(InvalidComplaintQueryError);
  });

  it.each([
    ["isLate=true", undefined],
    ["status=IN_PROGRESS&isLate=true", "IN_PROGRESS"],
    ["status=OPEN&isLate=true", "OPEN"],
    ["status=CLOSED&isLate=true", "CLOSED"],
    ["status=CANCELLED&isLate=true", "CANCELLED"],
  ])("adds late filters with AND without overwriting status for %s", (query, expectedStatus) => {
    const where = addComplaintRequestFilters(
      buildComplaintWhereFromParams(params(query)),
      params(query),
      new Date("2026-07-31T00:00:00Z")
    );

    if (expectedStatus) {
      expect(where.status).toBe(expectedStatus);
    } else {
      expect(where.status).toBeUndefined();
    }
    expect(where.AND).toEqual([
      {
        dueDate: { lt: new Date("2026-07-31T00:00:00Z") },
        status: {
          in: ["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE", "RESOLVED"],
        },
      },
    ]);
  });

  it("adds not-late filters without overwriting explicit status", () => {
    const where = addComplaintRequestFilters(
      buildComplaintWhereFromParams(params("status=IN_PROGRESS&isLate=false")),
      params("status=IN_PROGRESS&isLate=false"),
      new Date("2026-07-31T00:00:00Z")
    );

    expect(where.status).toBe("IN_PROGRESS");
    expect(where.AND).toEqual([
      {
        OR: [
          { dueDate: null },
          { dueDate: { gte: new Date("2026-07-31T00:00:00Z") } },
          { status: { notIn: ["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE", "RESOLVED"] } },
        ],
      },
    ]);
  });

  it("keeps existing dueDate range and intersects late filters through AND", () => {
    const where = addComplaintRequestFilters(
      buildComplaintWhereFromParams(params("from=2026-07-01&to=2026-07-31&isLate=true")),
      params("from=2026-07-01&to=2026-07-31&isLate=true"),
      new Date("2026-07-15T00:00:00Z")
    );

    expect(where.complaintDate).toEqual({
      gte: new Date("2026-07-01"),
      lte: new Date("2026-07-31"),
    });
    expect(where.AND).toEqual([
      {
        dueDate: { lt: new Date("2026-07-15T00:00:00Z") },
        status: { in: ["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE", "RESOLVED"] },
      },
    ]);
  });
});
