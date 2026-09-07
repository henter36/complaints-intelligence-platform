import { formatReportNumber } from "@/lib/reports/design-tokens";
import { preparePdfText } from "@/server/reports/arabic-pdf-text";
import { decodeComplainantToken } from "@/server/complaints/complainant-token";
import { getRepeatComplainantPersonDetail, type PersonComplaintRow } from "./repeat-complainant-person-detail-service";
import {
  createRepeatPdfDocument,
  drawPageTitle,
  drawSectionHeading,
  drawWarningBanner,
  drawPaginatedTable,
  drawFootersAndPageNumbers,
  formatScalarCell,
  type PdfColDef,
  type RepeatPdfContext,
} from "./repeat-complainant-pdf-shared";

export type PersonPdfOptions = {
  includeFullIdentifier: boolean;
  periodLabel: string;
};

const PII_WARNING =
  "يحتوي التقرير على بيانات شخصية تعريفية. يجب التعامل معه وفق ضوابط الوصول والمشاركة المعتمدة.";

function newPageFactory(ctx: RepeatPdfContext): () => number {
  return () => {
    ctx.doc.addPage();
    return ctx.margin;
  };
}

function patternDescription(pattern: "CONCENTRATED" | "DIVERSE", spansMultiplePeriods: boolean, recentActivity: boolean): string {
  const parts: string[] = [];
  parts.push(pattern === "CONCENTRATED" ? "تكرار مركز في تصنيف واحد بشكل رئيسي" : "تكرار متعدد الأنواع عبر عدة تصنيفات");
  if (spansMultiplePeriods) parts.push("مستمر عبر أكثر من فترة قياس");
  if (recentActivity) parts.push("نشاط حديث (معظم الشكاوى في آخر فترة)");
  return parts.join(" — ");
}

/**
 * No bullet/dot glyphs (U+25CF etc.) — the Amiri font used by this PDF has
 * no glyph for them (confirmed via a real generated PDF, same class of
 * issue as the arrow glyphs noted in the V2 executive brief) — an Arabic
 * comma-separated "شهر: عدد" list renders reliably instead, same convention
 * used for period trails elsewhere in this codebase.
 */
function timelineLine(timeline: { monthLabel: string; count: number }[]): string {
  return timeline.map((p) => `${p.monthLabel}: ${p.count}`).join("، ");
}

/**
 * Single-person repeat-complaint PDF: header, repeat summary, type
 * distribution, a simple timeline line, then the full complaint list.
 * Deliberately kept A4 PORTRAIT (unlike the bulk PDF) — this report only
 * ever shows one person's own data across a handful of narrow-column
 * tables, so it never runs into the bulk export's wide-table pressure.
 */
export async function renderRepeatComplainantPersonPdf(
  token: string,
  facility: string | null,
  baseParams: URLSearchParams,
  options: PersonPdfOptions
): Promise<Buffer | null> {
  const detail = await getRepeatComplainantPersonDetail(token, facility, baseParams);
  if (!detail) return null;

  const ctx = createRepeatPdfDocument("تحليل تكرار شخص", { orientation: "portrait" });
  let y = drawPageTitle(ctx, "تحليل تكرار الشكاوى — ملف شخص", options.periodLabel);

  if (options.includeFullIdentifier) {
    y = drawWarningBanner(ctx, PII_WARNING, y);
  }

  const identifierDisplay = options.includeFullIdentifier
    ? decodeComplainantToken(detail.person.complainantToken) ?? detail.person.complainantIdentifierMasked
    : detail.person.complainantIdentifierMasked;

  y = drawSectionHeading(ctx, "بيانات الشخص", y);
  const isMultiFacility = detail.person.facilitiesCount > 1;
  const facilityLine = isMultiFacility
    ? `عدة سجون (${formatReportNumber(detail.person.facilitiesCount)})`
    : detail.person.facility;
  const headerLines = [
    `الاسم: ${detail.person.complainantName ?? "غير متوفر"}`,
    `الهوية: ${identifierDisplay}`,
    `المنطقة: ${isMultiFacility ? "عدة مناطق" : detail.person.region}`,
    `السجن: ${facilityLine}`,
    `إجمالي الشكاوى: ${formatReportNumber(detail.person.totalComplaints)}`,
    `عدد الأنواع: ${formatReportNumber(detail.person.distinctComplaintTypesCount)}`,
  ];
  ctx.doc.font("Body").fontSize(11).fillColor("#073B31");
  for (const line of headerLines) {
    ctx.doc.text(preparePdfText(line), ctx.margin, y, { width: ctx.contentWidth, align: "right", wordSpacing: 1 });
    y += 20;
  }
  y += 6;

  // Multi-facility breakdown — only drawn when this person's complaints
  // actually span more than one facility; a single-facility person keeps
  // the pre-existing compact layout above unchanged.
  if (isMultiFacility) {
    y = drawSectionHeading(ctx, "السجون التي ظهرت فيها الشكاوى", y);
    const facilityColumns: PdfColDef[] = [
      { key: "facility", label: "السجن", weight: 2 },
      { key: "region", label: "المنطقة", weight: 1.2 },
      { key: "complaintsCount", label: "عدد الشكاوى", weight: 1 },
    ];
    y = drawPaginatedTable({
      doc: ctx.doc,
      rows: detail.person.facilities,
      columns: facilityColumns,
      x: ctx.margin,
      y,
      width: ctx.contentWidth,
      bottomLimit: ctx.bottomLimit,
      newPage: newPageFactory(ctx),
      formatCell: (row, key) => (key === "complaintsCount" ? formatReportNumber(row.complaintsCount) : String((row as Record<string, unknown>)[key])),
    });
    y += 10;
  }

  y = drawSectionHeading(ctx, "ملخص التكرار", y);
  const topType = detail.person.topComplaintTypes[0];
  const summaryLines = [
    topType ? `أكثر نوع شكوى: ${topType.label} (${formatReportNumber(topType.count)} مرات)` : null,
    `عدد الفترات التي ظهر فيها: ${formatReportNumber(detail.person.periodsPresent)}`,
    `وصف نمط التكرار: ${patternDescription(detail.person.pattern, detail.person.spansMultiplePeriods, detail.person.recentActivity)}`,
  ].filter((line): line is string => line !== null);
  ctx.doc.font("Body").fontSize(11).fillColor("#073B31");
  for (const line of summaryLines) {
    ctx.doc.text(preparePdfText(line), ctx.margin, y, { width: ctx.contentWidth, align: "right", wordSpacing: 1 });
    y += 20;
  }
  y += 6;

  y = drawSectionHeading(ctx, "توزيع أنواع الشكاوى", y);
  const typeColumns: PdfColDef[] = [
    { key: "label", label: "النوع", weight: 2, overflow: "wrap" },
    { key: "count", label: "العدد", weight: 1 },
    { key: "share", label: "النسبة", weight: 1 },
  ];
  y = drawPaginatedTable({
    doc: ctx.doc,
    rows: detail.person.topComplaintTypes.map((t) => ({
      label: t.label,
      count: t.count,
      share: detail.person.totalComplaints > 0 ? Math.round((t.count / detail.person.totalComplaints) * 1000) / 10 : 0,
    })),
    columns: typeColumns,
    x: ctx.margin,
    y,
    width: ctx.contentWidth,
    bottomLimit: ctx.bottomLimit,
    newPage: newPageFactory(ctx),
    formatCell: (row, key) => (key === "share" ? `${formatReportNumber(row.share)}%` : String((row as Record<string, unknown>)[key])),
  });
  y += 10;

  if (detail.timeline.length > 0) {
    y = drawSectionHeading(ctx, "التسلسل الزمني", y);
    ctx.doc.font("Body").fontSize(10).fillColor("#46534E").text(
      preparePdfText(timelineLine(detail.timeline)),
      ctx.margin, y, { width: ctx.contentWidth, align: "right", wordSpacing: 1 }
    );
    y += 30;
  }

  ctx.doc.addPage();
  y = ctx.margin;
  y = drawSectionHeading(ctx, "تفاصيل الشكاوى", y);
  // A facility column is only added when this person's complaints span more
  // than one facility — a single-facility report keeps the compact layout
  // (the ONE facility is already named in the header above, so repeating it
  // per row would only crowd out space the classification/subject columns need).
  const complaintColumns: PdfColDef[] = isMultiFacility
    ? [
        { key: "complaintNumber", label: "رقم الشكوى", weight: 0.8 },
        { key: "date", label: "التاريخ", weight: 0.8 },
        { key: "facility", label: "السجن", weight: 1.1 },
        { key: "classificationLabel", label: "التصنيف", weight: 1.2, overflow: "wrap" },
        { key: "subject", label: "الموضوع", weight: 1.6, overflow: "wrap" },
      ]
    : [
        { key: "complaintNumber", label: "رقم الشكوى", weight: 0.9 },
        { key: "date", label: "التاريخ", weight: 0.9 },
        { key: "classificationLabel", label: "التصنيف", weight: 1.4, overflow: "wrap" },
        { key: "subject", label: "الموضوع", weight: 1.9, overflow: "wrap" },
      ];
  drawPaginatedTable<PersonComplaintRow>({
    doc: ctx.doc,
    rows: detail.complaints,
    columns: complaintColumns,
    x: ctx.margin,
    y,
    width: ctx.contentWidth,
    bottomLimit: ctx.bottomLimit,
    newPage: newPageFactory(ctx),
    formatCell: (row, key) => formatScalarCell((row as unknown as Record<string, unknown>)[key]),
  });

  drawFootersAndPageNumbers(ctx);
  ctx.doc.end();
  return ctx.done;
}
