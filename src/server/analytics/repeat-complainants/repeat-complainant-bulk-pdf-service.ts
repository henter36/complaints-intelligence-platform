import { formatReportNumber } from "@/lib/reports/design-tokens";
import { preparePdfText } from "@/server/reports/arabic-pdf-text";
import { decodeComplainantToken } from "@/server/complaints/complainant-token";
import { getRepeatComplainantExportData } from "./repeat-complainant-analytics-service";
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
import type { RepeatFacilitySummaryRow } from "@/lib/analytics/repeat-complainant-directory";
import type { RepeatPersonRowForClient } from "./repeat-complainant-analytics-service";

export type BulkPdfOptions = {
  includeFullIdentifier: boolean;
  periodLabel: string;
  scopeLabel: string | null;
};

const PII_WARNING =
  "يحتوي التقرير على بيانات شخصية تعريفية. يجب التعامل معه وفق ضوابط الوصول والمشاركة المعتمدة.";

function newPageFactory(doc: PDFKit.PDFDocument): () => number {
  return () => {
    doc.addPage();
    return REPEAT_PDF_MARGIN;
  };
}

/**
 * Comprehensive repeat-complainant PDF (spec §12): summary page, top-facilities
 * table, then a paginated people table across as many pages as needed.
 * `includeFullIdentifier` is opt-in and OFF by default (spec §14) — when on,
 * the identifier column shows the real value AND a warning banner is drawn.
 */
export async function renderRepeatComplainantBulkPdf(
  params: URLSearchParams,
  options: BulkPdfOptions
): Promise<Buffer> {
  const data = await getRepeatComplainantExportData(params);
  const { doc, done } = createRepeatPdfDocument("تحليل تكرار الشكاوى");
  const newPage = newPageFactory(doc);

  let y = drawPageTitle(doc, "تحليل تكرار الشكاوى من نفس الشخص", options.periodLabel);
  if (options.scopeLabel) {
    y = drawSectionHeading(doc, options.scopeLabel, y);
  }
  if (options.includeFullIdentifier) {
    y = drawWarningBanner(doc, PII_WARNING, y);
  }

  y = drawSectionHeading(doc, "الملخص", y);
  const summaryLines = [
    `عدد الأشخاص المكررين: ${formatReportNumber(data.kpis.repeatedPeopleCount)}`,
    `إجمالي شكاواهم: ${formatReportNumber(data.kpis.repeatedComplaintsCount)}`,
    `نسبة التكرار من إجمالي الفترة: ${formatReportNumber(data.kpis.repeatedShareOfPeriodPercent)}%`,
    data.kpis.topFacility
      ? `أكثر السجون تكراراً: ${data.kpis.topFacility.facility} (${formatReportNumber(data.kpis.topFacility.repeatedPeopleCount)} شخص)`
      : null,
    data.kpis.topComplaintType ? `أكثر أنواع الشكاوى تكراراً: ${data.kpis.topComplaintType.label}` : null,
  ].filter((line): line is string => line !== null);
  doc.font("Body").fontSize(11).fillColor("#073B31");
  for (const line of summaryLines) {
    doc.text(preparePdfText(line), REPEAT_PDF_MARGIN, y, {
      width: REPEAT_PDF_CONTENT_WIDTH, align: "right", wordSpacing: 1,
    });
    y += 20;
  }

  doc.addPage();
  y = REPEAT_PDF_MARGIN;
  y = drawSectionHeading(doc, "أكثر السجون في تكرار الشكاوى", y);
  const facilityColumns: PdfColDef[] = [
    { key: "region", label: "المنطقة", weight: 0.9 },
    { key: "facility", label: "السجن", weight: 2.8 },
    { key: "repeatedPeopleCount", label: "الأشخاص المكررون", weight: 1.0 },
    { key: "repeatedComplaintsCount", label: "عدد الشكاوى", weight: 0.7 },
    { key: "repeatRatePercent", label: "النسبة", weight: 0.45 },
    { key: "topComplaintType", label: "أكثر نوع", weight: 0.7 },
  ];
  drawPaginatedTable<RepeatFacilitySummaryRow>({
    doc,
    rows: data.facilities,
    columns: facilityColumns,
    x: REPEAT_PDF_MARGIN,
    y,
    width: REPEAT_PDF_CONTENT_WIDTH,
    rowHeight: 22,
    bottomLimit: REPEAT_PDF_BOTTOM_LIMIT,
    newPage,
    formatCell: (row, key) => {
      if (key === "repeatRatePercent") return `${formatReportNumber(row.repeatRatePercent)}%`;
      if (key === "topComplaintType") return row.topComplaintType?.label ?? "—";
      return formatScalarCell((row as unknown as Record<string, unknown>)[key]);
    },
  });

  doc.addPage();
  y = REPEAT_PDF_MARGIN;
  y = drawSectionHeading(doc, "الأشخاص الأكثر تكراراً في تقديم الشكاوى", y);
  const peopleColumns: PdfColDef[] = [
    { key: "complainantName", label: "الاسم", weight: 1.3 },
    { key: "identifier", label: "الهوية", weight: 0.8 },
    { key: "region", label: "المنطقة", weight: 0.8 },
    { key: "facility", label: "السجن", weight: 1.8 },
    { key: "totalComplaints", label: "عدد الشكاوى", weight: 0.7 },
    { key: "distinctComplaintTypesCount", label: "الأنواع", weight: 0.6 },
    { key: "topType", label: "الأكثر تكراراً", weight: 1.1 },
  ];
  drawPaginatedTable<RepeatPersonRowForClient>({
    doc,
    rows: data.people,
    columns: peopleColumns,
    x: REPEAT_PDF_MARGIN,
    y,
    width: REPEAT_PDF_CONTENT_WIDTH,
    rowHeight: 22,
    bottomLimit: REPEAT_PDF_BOTTOM_LIMIT,
    newPage,
    formatCell: (row, key) => {
      if (key === "complainantName") return row.complainantName ?? "غير متوفر";
      if (key === "identifier") {
        if (!options.includeFullIdentifier) return row.complainantIdentifierMasked;
        return decodeComplainantToken(row.complainantToken) ?? row.complainantIdentifierMasked;
      }
      if (key === "facility") {
        return row.facilitiesCount > 1 ? `${formatReportNumber(row.facilitiesCount)} سجون` : row.facility;
      }
      if (key === "topType") return row.topComplaintTypes[0]?.label ?? "—";
      return formatScalarCell((row as unknown as Record<string, unknown>)[key]);
    },
  });

  drawFootersAndPageNumbers(doc);
  doc.end();
  return done;
}
