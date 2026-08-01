// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ReportMatrixSection } from "./report-contract";
import { buildMatrixTruncationMessage } from "./matrix-truncation";

function matrixSection(
  overrides: Partial<ReportMatrixSection> = {}
): ReportMatrixSection {
  return {
    id: "matrix",
    kind: "matrix",
    title: "المصفوفة",
    rowLabel: "الإدارة",
    columnLabel: "التصنيف",
    rowHeaders: ["إدارة أ", "إدارة ب"],
    columnHeaders: ["تصنيف أ", "تصنيف ب"],
    cells: [[1, 2], [3, 4]],
    rowTotals: [3, 7],
    columnTotals: [4, 6],
    grandTotal: 999,
    totalRows: 12,
    totalColumns: 8,
    truncatedRows: false,
    truncatedColumns: false,
    truncated: false,
    maxRows: 2,
    maxColumns: 2,
    ...overrides,
  };
}

describe("buildMatrixTruncationMessage", () => {
  it("describes truncated rows and columns using count metadata", () => {
    const message = buildMatrixTruncationMessage(matrixSection({
      truncatedRows: true,
      truncatedColumns: true,
      truncated: true,
    }));

    expect(message).toContain("١٢ صفاً");
    expect(message).toContain("٨ عموداً");
    expect(message).not.toContain("٩٩٩");
  });

  it("describes truncated rows only", () => {
    const message = buildMatrixTruncationMessage(matrixSection({
      truncatedRows: true,
      truncated: true,
    }));

    expect(message).toContain("١٢ صفاً");
    expect(message).toContain("أعلى ٢");
    expect(message).not.toContain("عموداً");
  });

  it("describes truncated columns only", () => {
    const message = buildMatrixTruncationMessage(matrixSection({
      truncatedColumns: true,
      truncated: true,
    }));

    expect(message).toContain("٨ عموداً");
    expect(message).toContain("أعلى ٢");
    expect(message).not.toContain("صفاً");
  });

  it("returns a defensive fallback for inconsistent legacy metadata", () => {
    expect(buildMatrixTruncationMessage(matrixSection({ truncated: true })))
      .toBe("تم اختصار عرض بيانات المصفوفة.");
  });

  it("returns null when the matrix is not truncated", () => {
    expect(buildMatrixTruncationMessage(matrixSection())).toBeNull();
  });
});
