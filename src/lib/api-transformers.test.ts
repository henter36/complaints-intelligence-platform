import { ComplaintStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { toComplaintListItem } from "./api-transformers";

const baseComplaint = {
  id: "cmp-transformer",
  status: ComplaintStatus.OPEN,
  dueDate: null,
  closedAt: null,
  complaintDate: new Date("2026-07-01T00:00:00Z"),
  receivedAt: null,
};

describe("api transformers", () => {
  it("prefers the classification label and color", () => {
    const item = toComplaintListItem({
      ...baseComplaint,
      classification: { nameAr: "تصنيف فرعي", color: "#123456" },
      category: { nameAr: "تصنيف رئيسي" },
    });

    expect(item.classification).toEqual({ name: "تصنيف فرعي", color: "#123456" });
  });

  it("falls back to category when classification is absent", () => {
    const item = toComplaintListItem({
      ...baseComplaint,
      classification: null,
      category: { nameAr: "تصنيف رئيسي" },
    });

    expect(item.classification).toEqual({ name: "تصنيف رئيسي", color: "#64748b" });
  });

  it("returns no legacy classification when both classification and category are absent", () => {
    const item = toComplaintListItem({
      ...baseComplaint,
      classification: null,
      category: null,
    });

    expect(item.classification).toBeNull();
  });
});
