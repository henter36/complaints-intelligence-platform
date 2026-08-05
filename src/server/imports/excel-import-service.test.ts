// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import { applyOperationalImportSemantics } from "./operational-import-semantics";

/**
 * Excel import path relies on applyOperationalImportSemantics during normalization.
 * These tests lock the closedAt ← lastUpdatedAt derivation contract.
 */
describe("excel import closedAt derivation", () => {
  it("sets closedAt from lastUpdatedAt for closed rows missing closedAt", () => {
    const lastUpdatedAt = new Date("2026-08-01T12:00:00.000Z");
    const result = applyOperationalImportSemantics({
      status: ComplaintStatus.CLOSED,
      sourceUpdatedAt: lastUpdatedAt,
    });
    expect(result.row.closedAt?.toISOString()).toBe(lastUpdatedAt.toISOString());
    expect(result.derived.some((d) => d.code === "CLOSED_AT_DERIVED_FROM_LAST_UPDATED_AT")).toBe(true);
  });

  it("never derives closedAt for open rows", () => {
    const result = applyOperationalImportSemantics({
      status: ComplaintStatus.OPEN,
      sourceUpdatedAt: new Date("2026-08-01T12:00:00.000Z"),
    });
    expect(result.row.closedAt).toBeUndefined();
    expect(result.derived.some((d) => d.code === "CLOSED_AT_DERIVED_FROM_LAST_UPDATED_AT")).toBe(false);
  });
});
