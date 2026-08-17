import { describe, expect, it } from "vitest";
import { buildExplorerDrilldownQuery } from "./drilldown-query";

describe("buildExplorerDrilldownQuery", () => {
  it("maps facility/classificationId/from/to straight through", () => {
    const query = buildExplorerDrilldownQuery({
      drilldownFilters: { facility: "سجن أ", classificationId: "cls-1", from: "2026-01-01", to: "2026-01-31" },
    });
    expect(query).toEqual({ facility: "سجن أ", classificationId: "cls-1", from: "2026-01-01", to: "2026-01-31" });
  });

  it("stringifies booleans and numbers, and drops nulls", () => {
    const query = buildExplorerDrilldownQuery({
      drilldownFilters: { isLate: true, region: null, count: 5 },
    });
    expect(query).toEqual({ isLate: "true", count: "5" });
  });

  it("returns an empty object for no filters", () => {
    expect(buildExplorerDrilldownQuery({ drilldownFilters: {} })).toEqual({});
  });
});
