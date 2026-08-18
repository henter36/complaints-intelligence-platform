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
  REPEAT_PDF_MARGIN,
  REPEAT_PDF_CONTENT_WIDTH,
  REPEAT_PDF_BOTTOM_LIMIT,
  type PdfColDef,
} from "./repeat-complainant-pdf-shared";

export type PersonPdfOptions = {
  includeFullIdentifier: boolean;
  periodLabel: string;
};

const PII_WARNING =
  "يحتوي التقرير على بيانات شخصية تعريفية. يجب التعامل معه وفق ضوابط الوصول والمشاركة المعتمدة.";

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
 * Single-person repeat-complaint PDF (spec §13): header, repeat summary,
 * type distribution, a simple timeline line, then the full complaint list.
 */
export async function renderRepeatComplainantPersonPdf(
  token: string,
  facility: string | null,
  baseParams: URLSearchParams,
  options: PersonPdfOptions
): Promise<Buffer | null> {
  const detail = await getRepeatComplainantPersonDetail(token, facility, baseParams);
  if (!detail) return null;

  const { doc, done } = createRepeatPdfDocument("تحليل تكرار شخص");
  let y = drawPageTitle(doc, "تحليل تكرار الشكاوى — ملف شخص", options.periodLabel);

  if (options.includeFullIdentifier) {
    y = drawWarningBanner(doc, PII_WARNING, y);
  }

  const identifierDisplay = options.includeFullIdentifier
    ? decodeComplainantToken(detail.person.complainantToken) ?? detail.person.complainantIdentifierMasked
    : detail.person.complainantIdentifierMasked;

  y = drawSectionHeading(doc, "بيانات الشخص", y);
  const isMultiFacility = detail.person.facilitiesCount > 1;
  const headerLines = [
    `الاسم: ${detail.person.complainantName ?? "غير متوفر"}`,
    `الهوية: ${identifierDisplay}`,
    `المنطقة: ${isMultiFacility ? "عدة مناطق" : detail.person.region}`,
    `السجن: ${isMultiFacility ? `عدة سجون (${formatReportNumber(detail.person.facilitiesCount)})` : detail.person.facility}`,
    `إجمالي الشكاوى: ${formatReportNumber(detail.person.totalComplaints)}`,
    `عدد الأنواع: ${formatReportNumber(detail.person.distinctComplaintTypesCount)}`,
  ];
  doc.font("Body").fontSize(11).fillColor("#073B31");
  for (const line of headerLines) {
    doc.text(preparePdfText(line), REPEAT_PDF_MARGIN, y, { width: REPEAT_PDF_CONTENT_WIDTH, align: "right", wordSpacing: 1 });
    y += 20;
  }
  y += 6;

  // Multi-facility breakdown (spec §18) — only drawn when this person's
  // complaints actually span more than one facility; a single-facility
  // person keeps the pre-existing compact layout above unchanged.
  if (isMultiFacility) {
    y = drawSectionHeading(doc, "السجون التي ظهرت فيها الشكاوى", y);
    const facilityColumns: PdfColDef[] = [
      { key: "facility", label: "السجن", weight: 2 },
      { key: "region", label: "المنطقة", weight: 1.2 },
      { key: "complaintsCount", label: "عدد الشكاوى", weight: 1 },
    ];
    y = drawPaginatedTable({
      doc,
      rows: detail.person.facilities,
      columns: facilityColumns,
      x: REPEAT_PDF_MARGIN,
      y,
      width: REPEAT_PDF_CONTENT_WIDTH,
      rowHeight: 20,
      bottomLimit: REPEAT_PDF_BOTTOM_LIMIT,
      newPage: () => { doc.addPage(); return REPEAT_PDF_MARGIN; },
      formatCell: (row, key) => (key === "complaintsCount" ? formatReportNumber(row.complaintsCount) : String((row as Record<string, unknown>)[key])),
    });
    y += 10;
  }

  y = drawSectionHeading(doc, "ملخص التكرار", y);
  const topType = detail.person.topComplaintTypes[0];
  const summaryLines = [
    topType ? `أكثر نوع شكوى: ${topType.label} (${formatReportNumber(topType.count)} مرات)` : null,
    `عدد الفترات التي ظهر فيها: ${formatReportNumber(detail.person.periodsPresent)}`,
    `وصف نمط التكرار: ${patternDescription(detail.person.pattern, detail.person.spansMultiplePeriods, detail.person.recentActivity)}`,
  ].filter((line): line is string => line !== null);
  doc.font("Body").fontSize(11).fillColor("#073B31");
  for (const line of summaryLines) {
    doc.text(preparePdfText(line), REPEAT_PDF_MARGIN, y, { width: REPEAT_PDF_CONTENT_WIDTH, align: "right", wordSpacing: 1 });
    y += 20;
  }
  y += 6;

  y = drawSectionHeading(doc, "توزيع أنواع الشكاوى", y);
  const typeColumns: PdfColDef[] = [
    { key: "label", label: "النوع", weight: 2 },
    { key: "count", label: "العدد", weight: 1 },
    { key: "share", label: "النسبة", weight: 1 },
  ];
  y = drawPaginatedTable({
    doc,
    rows: detail.person.topComplaintTypes.map((t) => ({
      label: t.label,
      count: t.count,
      share: detail.person.totalComplaints > 0 ? Math.round((t.count / detail.person.totalComplaints) * 1000) / 10 : 0,
    })),
    columns: typeColumns,
    x: REPEAT_PDF_MARGIN,
    y,
    width: REPEAT_PDF_CONTENT_WIDTH,
    rowHeight: 20,
    bottomLimit: REPEAT_PDF_BOTTOM_LIMIT,
    newPage: () => { doc.addPage(); return REPEAT_PDF_MARGIN; },
    formatCell: (row, key) => (key === "share" ? `${formatReportNumber(row.share)}%` : String((row as Record<string, unknown>)[key])),
  });
  y += 10;

  if (detail.timeline.length > 0) {
    y = drawSectionHeading(doc, "التسلسل الزمني", y);
    doc.font("Body").fontSize(10).fillColor("#46534E").text(
      preparePdfText(timelineLine(detail.timeline)),
      REPEAT_PDF_MARGIN, y, { width: REPEAT_PDF_CONTENT_WIDTH, align: "right", wordSpacing: 1 }
    );
    y += 30;
  }

  doc.addPage();
  y = REPEAT_PDF_MARGIN;
  y = drawSectionHeading(doc, "تفاصيل الشكاوى", y);
  // A facility column is only added when this person's complaints span more
  // than one facility — a single-facility report keeps the compact layout
  // (the ONE facility is already named in the header above, so repeating it
  // per row would only crowd out space the classification/subject columns need).
  const complaintColumns: PdfColDef[] = isMultiFacility
    ? [
        { key: "complaintNumber", label: "رقم الشكوى", weight: 0.8 },
        { key: "date", label: "التاريخ", weight: 0.8 },
        { key: "facility", label: "السجن", weight: 1.1 },
        { key: "classificationLabel", label: "التصنيف", weight: 1.2 },
        { key: "subject", label: "الموضوع", weight: 1.6 },
      ]
    : [
        { key: "complaintNumber", label: "رقم الشكوى", weight: 0.9 },
        { key: "date", label: "التاريخ", weight: 0.9 },
        { key: "classificationLabel", label: "التصنيف", weight: 1.4 },
        { key: "subject", label: "الموضوع", weight: 1.9 },
      ];
  drawPaginatedTable<PersonComplaintRow>({
    doc,
    rows: detail.complaints,
    columns: complaintColumns,
    x: REPEAT_PDF_MARGIN,
    y,
    width: REPEAT_PDF_CONTENT_WIDTH,
    rowHeight: 22,
    bottomLimit: REPEAT_PDF_BOTTOM_LIMIT,
    newPage: () => { doc.addPage(); return REPEAT_PDF_MARGIN; },
    formatCell: (row, key) => formatScalarCell((row as unknown as Record<string, unknown>)[key]),
  });

  drawFootersAndPageNumbers(doc);
  doc.end();
  return done;
}
