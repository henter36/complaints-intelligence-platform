import { describe, expect, it } from "vitest";
import { toComplaintListItem } from "./api-transformers";
import { average, isComplaintLate, roundToTenth } from "./complaint-metrics";

describe("complaint metrics", () => {
  const now = new Date("2024-10-10T12:00:00.000Z");

  it("does not mark complaints without due dates as late", () => {
    expect(isComplaintLate({ status: "open", dueDate: null, closureDate: null }, now)).toBe(false);
  });

  it("marks open and closed complaints late only when due-date rules match", () => {
    expect(
      isComplaintLate(
        { status: "open", dueDate: new Date("2024-10-09T12:00:00.000Z"), closureDate: null },
        now
      )
    ).toBe(true);
    expect(
      isComplaintLate(
        {
          status: "closed",
          dueDate: new Date("2024-10-09T12:00:00.000Z"),
          closureDate: new Date("2024-10-08T12:00:00.000Z"),
        },
        now
      )
    ).toBe(false);
  });

  it("enriches API complaint list rows with an isLate flag", () => {
    const item = toComplaintListItem(
      {
        id: "cmp_1",
        status: "open",
        dueDate: new Date("2024-10-09T12:00:00.000Z"),
        closureDate: null,
      },
      now
    );

    expect(item).toMatchObject({ id: "cmp_1", isLate: true });
  });

  it("calculates averages and one-decimal rounding", () => {
    expect(average([1, 2, 3])).toBe(2);
    expect(average([])).toBe(0);
    expect(roundToTenth(12.34)).toBe(12.3);
  });
});
