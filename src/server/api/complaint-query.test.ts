import { describe, expect, it } from "vitest";
import {
  addComplaintRequestFilters,
  buildComplaintWhereFromParams,
  InvalidComplaintQueryError,
  mergeComplaintWhere,
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
      lt: new Date("2026-08-01T00:00:00.000Z"),
    });
  });

  it("accepts a valid inclusive date range", () => {
    expect(buildComplaintWhereFromParams(params("from=2026-07-01&to=2026-07-31")).complaintDate).toEqual({
      gte: new Date("2026-07-01"),
      lt: new Date("2026-08-01T00:00:00.000Z"),
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
        lt: new Date("2026-08-01T00:00:00.000Z"),
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

    expect(where.AND).toEqual(expect.arrayContaining([
      expect.objectContaining(expectedStatus ? { status: expectedStatus } : { isDeleted: false }),
      {
        dueDate: { lt: new Date("2026-07-31T00:00:00Z") },
        status: {
          in: ["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE"],
        },
      },
    ]));
  });

  it("adds not-late filters without overwriting explicit status", () => {
    const where = addComplaintRequestFilters(
      buildComplaintWhereFromParams(params("status=IN_PROGRESS&isLate=false")),
      params("status=IN_PROGRESS&isLate=false"),
      new Date("2026-07-31T00:00:00Z")
    );

    expect(where.AND).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "IN_PROGRESS" }),
      {
        OR: [
          { dueDate: null },
          { dueDate: { gte: new Date("2026-07-31T00:00:00Z") } },
          { status: { notIn: ["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE"] } },
        ],
      },
    ]));
  });

  it("keeps existing dueDate range and intersects late filters through AND", () => {
    const where = addComplaintRequestFilters(
      buildComplaintWhereFromParams(params("from=2026-07-01&to=2026-07-31&isLate=true")),
      params("from=2026-07-01&to=2026-07-31&isLate=true"),
      new Date("2026-07-15T00:00:00Z")
    );

    expect(where.AND).toEqual(expect.arrayContaining([
      expect.objectContaining({
        complaintDate: {
          gte: new Date("2026-07-01"),
          lt: new Date("2026-08-01T00:00:00.000Z"),
        },
      }),
      {
        dueDate: { lt: new Date("2026-07-15T00:00:00Z") },
        status: { in: ["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE"] },
      },
    ]));
  });

  it("merges base and additional AND predicates without overwriting them", () => {
    const where = mergeComplaintWhere(
      { isDeleted: false, AND: [{ status: "OPEN" }] },
      { AND: [{ dueDate: { lt: new Date("2026-07-31T00:00:00Z") } }] }
    );

    expect(where).toEqual({
      AND: [
        { isDeleted: false },
        { status: "OPEN" },
        { dueDate: { lt: new Date("2026-07-31T00:00:00Z") } },
      ],
    });
  });

  it("preserves base status when additional late filters add status intersection", () => {
    const where = mergeComplaintWhere(
      { isDeleted: false, status: "CLOSED" },
      {
        isDeleted: false,
        AND: [
          {
            dueDate: { lt: new Date("2026-07-31T00:00:00Z") },
            status: { in: ["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE"] },
          },
        ],
      }
    );

    expect(where).toEqual({
      AND: [
        { isDeleted: false, status: "CLOSED" },
        { isDeleted: false },
        {
          dueDate: { lt: new Date("2026-07-31T00:00:00Z") },
          status: { in: ["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE"] },
        },
      ],
    });
  });

  it("preserves OR predicates during complaint where merges", () => {
    const where = mergeComplaintWhere(
      { OR: [{ subject: { contains: "أ" } }] },
      { isDeleted: false, status: "OPEN" }
    );

    expect(where).toEqual({
      AND: [
        { OR: [{ subject: { contains: "أ" } }] },
        { isDeleted: false, status: "OPEN" },
      ],
    });
  });

  it("keeps contradictory predicates instead of overwriting one side", () => {
    const where = mergeComplaintWhere(
      { classificationId: "cls-1" },
      { AND: [{ classificationId: null }] }
    );

    expect(where).toEqual({
      AND: [
        { classificationId: "cls-1" },
        { classificationId: null },
      ],
    });
  });
});
