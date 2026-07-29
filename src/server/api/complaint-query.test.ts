import { describe, expect, it } from "vitest";
import {
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
});
