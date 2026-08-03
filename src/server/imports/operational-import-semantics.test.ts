import { describe, expect, it } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import {
  DESCRIPTION_COLUMN_MISSING_BATCH_MESSAGE,
  DESCRIPTION_VALUE_MISSING_ROW_MESSAGE,
  applyOperationalImportSemantics,
  buildMissingDescriptionRowWarning,
} from "./operational-import-semantics";

describe("applyOperationalImportSemantics", () => {
  it("uses sourceDetail as subject without changing the description", () => {
    const result = applyOperationalImportSemantics({
      sourceDetail: "  طلب نقل  ",
      description: "تفاصيل الشكوى المكتوبة",
      status: ComplaintStatus.OPEN,
    });

    expect(result.row.subject).toBe("طلب نقل");
    expect(result.row.description).toBe("تفاصيل الشكوى المكتوبة");
    expect(result.derived).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SUBJECT_DERIVED_FROM_SOURCE_DETAIL" }),
      ])
    );
  });

  it("preserves an explicit subject over sourceDetail", () => {
    const result = applyOperationalImportSemantics({
      subject: "موضوع صريح",
      sourceDetail: "موضوع مصدر",
      status: ComplaintStatus.OPEN,
    });

    expect(result.row.subject).toBe("موضوع صريح");
    expect(result.derived).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SUBJECT_DERIVED_FROM_SOURCE_DETAIL" }),
      ])
    );
  });

  it("derives closedAt from sourceUpdatedAt for a closed complaint", () => {
    const sourceUpdatedAt = new Date("2026-07-01T10:30:00.000Z");
    const result = applyOperationalImportSemantics({
      status: ComplaintStatus.CLOSED,
      sourceUpdatedAt,
    });

    expect(result.row.closedAt?.toISOString()).toBe(sourceUpdatedAt.toISOString());
    expect(result.warnings).toHaveLength(0);
    expect(result.derived).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CLOSED_AT_DERIVED_FROM_SOURCE_UPDATED_AT" }),
      ])
    );
  });

  it("preserves an explicit closedAt over sourceUpdatedAt", () => {
    const explicitClosedAt = new Date("2026-06-30T10:30:00.000Z");
    const result = applyOperationalImportSemantics({
      status: ComplaintStatus.CLOSED,
      closedAt: explicitClosedAt,
      sourceUpdatedAt: new Date("2026-07-01T10:30:00.000Z"),
    });

    expect(result.row.closedAt?.toISOString()).toBe(explicitClosedAt.toISOString());
    expect(result.derived).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CLOSED_AT_DERIVED_FROM_SOURCE_UPDATED_AT" }),
      ])
    );
  });

  it("warns only when a closed complaint has no usable close date", () => {
    const closed = applyOperationalImportSemantics({ status: ComplaintStatus.CLOSED });
    const open = applyOperationalImportSemantics({ status: ComplaintStatus.OPEN });

    expect(closed.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CLOSED_STATUS_WITHOUT_SOURCE_UPDATED_AT" }),
      ])
    );
    expect(open.warnings).toHaveLength(0);
  });

  it("clears closedAt for a non-closed status", () => {
    const result = applyOperationalImportSemantics({
      status: ComplaintStatus.IN_PROGRESS,
      closedAt: new Date("2026-07-01T10:30:00.000Z"),
      sourceUpdatedAt: new Date("2026-07-02T10:30:00.000Z"),
    });

    expect(result.row.closedAt).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
    expect(result.derived).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CLOSED_AT_IGNORED_FOR_NON_CLOSED_STATUS" }),
      ])
    );
  });
});

describe("description quality messages", () => {
  it("keeps batch-level and row-level messages distinct", () => {
    expect(DESCRIPTION_COLUMN_MISSING_BATCH_MESSAGE).toContain("لم يُعثر على عمود");
    expect(DESCRIPTION_VALUE_MISSING_ROW_MESSAGE).toContain("فارغة في هذا الصف");
    expect(buildMissingDescriptionRowWarning()).toMatchObject({
      code: "DESCRIPTION_VALUE_MISSING",
      message: DESCRIPTION_VALUE_MISSING_ROW_MESSAGE,
      level: "warning",
    });
  });
});
