import { describe, expect, it } from "vitest";
import { buildAiAnalysisComplaintWhere } from "./ai-service";

describe("buildAiAnalysisComplaintWhere date bounds", () => {
  it("treats calendar dateTo=YYYY-MM-DD as inclusive through end of that UTC day", () => {
    expect(
      buildAiAnalysisComplaintWhere({
        dateFrom: "2025-09-08",
        dateTo: "2026-07-15",
      }).complaintDate
    ).toEqual({
      gte: new Date("2025-09-08T00:00:00.000Z"),
      lt: new Date("2026-07-16T00:00:00.000Z"),
    });
  });

  it("does not use lte against midnight of dateTo", () => {
    const complaintDate = buildAiAnalysisComplaintWhere({
      dateTo: "2026-07-15",
    }).complaintDate as Record<string, Date>;

    expect(complaintDate).toEqual({
      lt: new Date("2026-07-16T00:00:00.000Z"),
    });
    expect(complaintDate).not.toHaveProperty("lte");
  });
});
