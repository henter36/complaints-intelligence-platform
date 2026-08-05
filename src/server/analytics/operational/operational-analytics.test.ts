import { describe, expect, it } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import {
  buildComplaintWhere,
  parseComplaintQuery,
} from "@/server/complaints/complaint-query-service";
import {
  formatInstantInRiyadh,
  normalizeActionTakenKey,
  resolveFreshnessBucket,
} from "@/server/analytics/operational/operational-analytics-service";
import { OPERATIONAL_UNSPECIFIED } from "@/server/analytics/operational/operational-analytics-types";
import {
  detectOperationalTextPatterns,
  iterTextSignalSources,
} from "@/server/analytics/operational/operational-text-signals";
import { REPORT_DEFINITIONS } from "@/server/reports/report-definition-service";
import { ReportType } from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function q(query: string) {
  return new URLSearchParams(query);
}

describe("operational field semantic separation", () => {
  it("keeps sourceOrigin independent from channel", () => {
    const where = buildComplaintWhere(
      parseComplaintQuery(q("sourceOrigin=الجهاز الرئيسي&channel=الهاتف"))
    );
    expect(where.sourceOrigin).toBe("الجهاز الرئيسي");
    expect(where.channel).toBe("الهاتف");
  });

  it("keeps sourceStatus independent from status", () => {
    const where = buildComplaintWhere(
      parseComplaintQuery(q("sourceStatus=مغلقة&status=OPEN"))
    );
    expect(where.sourceStatus).toBe("مغلقة");
    expect(where.status).toBe(ComplaintStatus.OPEN);
  });

  it("keeps sourceActionStatus independent from status", () => {
    const where = buildComplaintWhere(
      parseComplaintQuery(q("sourceActionStatus=جديد&status=CLOSED"))
    );
    expect(where.sourceActionStatus).toBe("جديد");
    expect(where.status).toBe(ComplaintStatus.CLOSED);
  });

  it("applies hasActionTaken and hasResolution as independent presence filters", () => {
    const where = buildComplaintWhere(
      parseComplaintQuery(q("hasActionTaken=true&hasResolution=false"))
    );
    const serialized = JSON.stringify(where);
    expect(serialized).toContain("actionTaken");
    expect(serialized).toContain("resolution");
  });

  it("searches actionDescription separately from description", () => {
    const where = buildComplaintWhere(parseComplaintQuery(q("search=متابعة")));
    const or = (where.AND as Array<Record<string, unknown>>).find((clause) => Array.isArray(clause.OR));
    const fields = ((or?.OR as Array<Record<string, unknown>>) ?? []).flatMap((entry) =>
      Object.keys(entry)
    );
    expect(fields).toEqual(
      expect.arrayContaining(["description", "actionDescription", "sourceDetail"])
    );
  });

  it("filters wingCode including unspecified sentinel", () => {
    const specified = buildComplaintWhere(parseComplaintQuery(q("wingCode=3")));
    expect(specified.wingCode).toBe("3");

    const unspecified = buildComplaintWhere(
      parseComplaintQuery(q(`wingCode=${OPERATIONAL_UNSPECIFIED}`))
    );
    expect(JSON.stringify(unspecified)).toContain("wingCode");
    expect(JSON.stringify(unspecified)).toContain("null");
  });
});

describe("freshness buckets and Riyadh display", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");

  it("classifies freshness buckets at boundaries", () => {
    expect(resolveFreshnessBucket(null, now)).toBe("missing");
    expect(resolveFreshnessBucket(new Date(now.getTime() - 12 * 60 * 60 * 1000), now)).toBe("fresh_1d");
    expect(resolveFreshnessBucket(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), now)).toBe(
      "stale_1_3d"
    );
    expect(resolveFreshnessBucket(new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000), now)).toBe(
      "stale_3_7d"
    );
    expect(resolveFreshnessBucket(new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000), now)).toBe(
      "stale_7d_plus"
    );
  });

  it("formats display timestamps in Asia/Riyadh without mutating storage", () => {
    const utc = new Date("2026-07-15T21:00:00.000Z");
    const formatted = formatInstantInRiyadh(utc);
    expect(formatted).toBeTruthy();
    expect(utc.toISOString()).toBe("2026-07-15T21:00:00.000Z");
  });

  it("normalizes actionTaken keys without writing a permanent dictionary", () => {
    expect(normalizeActionTakenKey("  تم  الإجراء  ")).toBe("تم الإجراء");
  });
});

describe("operational text signal sources", () => {
  it("keeps description, sourceDetail, and actionDescription as separate sources", () => {
    const sources = iterTextSignalSources({
      description: "نص الشكوى",
      sourceDetail: "تفصيل مصدر",
      actionDescription: "وصف إجراء",
    });
    expect(sources.map((s) => s.source)).toEqual([
      "COMPLAINT_DESCRIPTION",
      "SOURCE_DETAIL",
      "ACTION_DESCRIPTION",
    ]);
  });

  it("labels pattern findings with their text source", () => {
    const findings = detectOperationalTextPatterns({
      description: "لم يتم اتخاذ إجراء مناسب",
      sourceDetail: null,
      actionDescription: "جار العمل على الطلب",
    });
    expect(findings.some((f) => f.source === "COMPLAINT_DESCRIPTION" && f.code === "NO_ACTION")).toBe(
      true
    );
    expect(
      findings.some((f) => f.source === "ACTION_DESCRIPTION" && f.code === "INCOMPLETE_ACTION")
    ).toBe(true);
  });
});

describe("reports and export regression — operational fields excluded", () => {
  const forbidden = [
    "sourceOrigin",
    "sourceStatus",
    "sourceActionStatus",
    "sourceDetail",
    "sourceClosedBy",
    "actionTaken",
    "actionDescription",
    "wingCode",
    "sourceUpdatedAt",
    "sourceModifiedAt",
    "sourceUpdatedBy",
  ];

  it("does not add operational fields to report default columns or filters", () => {
    for (const definition of Object.values(REPORT_DEFINITIONS)) {
      for (const field of forbidden) {
        expect(definition.defaultColumns).not.toContain(field);
        expect(definition.supportedFilters).not.toContain(field);
      }
    }
    expect(REPORT_DEFINITIONS[ReportType.COMPLAINT_DETAIL].defaultColumns).toContain("channel");
  });

  it("does not add operational fields to CSV export rows", () => {
    const exportSource = readFileSync(
      resolve(process.cwd(), "src/app/api/complaints/export/route.ts"),
      "utf8"
    );
    for (const field of forbidden) {
      expect(exportSource).not.toContain(`item.${field}`);
    }
    expect(exportSource).toContain("item.channel");
  });
});
