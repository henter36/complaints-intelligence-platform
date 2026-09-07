import { formatReportNumber } from "@/lib/reports/design-tokens";
import { preparePdfText } from "@/server/reports/arabic-pdf-text";
import { decodeComplainantToken } from "@/server/complaints/complainant-token";
import {
  getRepeatComplainantExportData,
  type RepeatComplainantExportFacilitySection,
  type RepeatPersonRowForClient,
} from "./repeat-complainant-analytics-service";
import {
  createRepeatPdfDocument,
  drawPageTitle,
  drawSectionHeading,
  drawWarningBanner,
  drawFacilitySectionHeading,
  drawRegionHeading,
  drawPaginatedTable,
  drawFootersAndPageNumbers,
  formatScalarCell,
  wouldOverflow,
  type PdfColDef,
  type RepeatPdfContext,
} from "./repeat-complainant-pdf-shared";
import type { RepeatFacilitySummaryRow } from "@/lib/analytics/repeat-complainant-directory";

export type BulkPdfOptions = {
  includeFullIdentifier: boolean;
  periodLabel: string;
  scopeLabel: string | null;
};

const PII_WARNING =
  "يحتوي التقرير على بيانات شخصية تعريفية. يجب التعامل معه وفق ضوابط الوصول والمشاركة المعتمدة.";

function newPageFactory(ctx: RepeatPdfContext): () => number {
  return () => {
    ctx.doc.addPage();
    return ctx.margin;
  };
}

/** Minimum vertical space a facility section's heading + table header + one row need before it's worth starting on the current page (spec §18). */
const FACILITY_SECTION_MIN_HEIGHT = 46 + 10 + 24 + 24; // heading box + gap + table header + one row

const PEOPLE_COLUMNS: PdfColDef[] = [
  { key: "complainantName", label: "الاسم", weight: 2.2, overflow: "wrap", maxLines: 2 },
  { key: "identity", label: "الهوية", weight: 1.3, overflow: "none" },
  { key: "totalComplaints", label: "عدد الشكاوى", weight: 0.9 },
  { key: "repeatCount", label: "عدد التكرارات", weight: 0.9 },
  { key: "distinctComplaintTypesCount", label: "عدد الأنواع", weight: 0.9 },
  { key: "topType", label: "الأكثر تكراراً", weight: 1.6, overflow: "wrap", maxLines: 2 },
  { key: "sameTypeRepeatCount", label: "أعلى تكرار لنفس النوع", weight: 1.0 },
  { key: "lastComplaintDate", label: "آخر شكوى", weight: 1.0 },
];

function formatPersonCell(row: RepeatPersonRowForClient, key: string, includeFullIdentifier: boolean): string {
  if (key === "complainantName") return row.complainantName ?? "غير متوفر";
  if (key === "identity") {
    if (!includeFullIdentifier) return row.complainantIdentifierMasked;
    return decodeComplainantToken(row.complainantToken) ?? row.complainantIdentifierMasked;
  }
  if (key === "repeatCount") return formatReportNumber(Math.max(0, row.totalComplaints - 1));
  if (key === "topType") {
    const top = row.topComplaintTypes[0];
    return top ? `${top.label} (${formatReportNumber(top.count)})` : "—";
  }
  return formatScalarCell((row as unknown as Record<string, unknown>)[key]);
}

/**
 * Draws one facility's own heading + people table, starting a new page
 * first if the heading would otherwise be stranded alone at the bottom of
 * the current page (spec §18). Returns the y position after the section.
 */
function drawFacilitySection(
  ctx: RepeatPdfContext,
  section: RepeatComplainantExportFacilitySection,
  y: number,
  includeFullIdentifier: boolean
): number {
  const newPage = newPageFactory(ctx);
  let cursor = y;
  if (wouldOverflow(ctx, cursor, FACILITY_SECTION_MIN_HEIGHT)) {
    cursor = newPage();
  }
  cursor = drawFacilitySectionHeading(ctx, {
    facility: section.facility.facility,
    region: section.facility.region,
    peopleCount: section.people.length,
    complaintsCount: section.people.reduce((sum, p) => sum + p.totalComplaints, 0),
  }, cursor);

  cursor = drawPaginatedTable<RepeatPersonRowForClient>({
    doc: ctx.doc,
    rows: section.people,
    columns: PEOPLE_COLUMNS,
    x: ctx.margin,
    y: cursor,
    width: ctx.contentWidth,
    bottomLimit: ctx.bottomLimit,
    newPage: () => {
      const resumeY = newPage();
      // A small "السجن — تابع" heading (no stats repeated) at the top of a
      // continuation page (spec §19), then the table header is drawn
      // immediately after by drawPaginatedTable's own newPage callback flow.
      return drawFacilitySectionHeading(ctx, {
        facility: section.facility.facility,
        region: section.facility.region,
        peopleCount: section.people.length,
        complaintsCount: 0,
        continued: true,
      }, resumeY);
    },
    formatCell: (row, key) => formatPersonCell(row, key, includeFullIdentifier),
  });

  return cursor + 14;
}

const FACILITY_SUMMARY_COLUMNS: PdfColDef[] = [
  { key: "facility", label: "السجن", weight: 2.2, overflow: "wrap", maxLines: 2 },
  { key: "region", label: "المنطقة", weight: 1.2 },
  { key: "repeatedPeopleCount", label: "الأشخاص المكررون", weight: 1.1 },
  { key: "repeatedComplaintsCount", label: "إجمالي شكاواهم", weight: 1.1 },
  { key: "repeatedPeopleSharePercent", label: "نسبة الأشخاص المكررين", weight: 1.2 },
  { key: "highestRepeatByOnePerson", label: "أعلى شخص", weight: 0.9 },
  { key: "topComplaintType", label: "أكثر نوع", weight: 1.6, overflow: "wrap", maxLines: 2 },
];

/**
 * Comprehensive repeat-complainant PDF: summary page, top-facilities table,
 * then every facility's own people section grouped region -> facility
 * (spec: never one flat people table). A4 LANDSCAPE — this is the ONE
 * repeat-complainant PDF wide enough to need it; the single-person PDF
 * stays portrait (see repeat-complainant-person-pdf-service.ts).
 * `includeFullIdentifier` is opt-in and OFF by default — when on, the
 * identity column shows the real value AND a warning banner is drawn.
 */
export async function renderRepeatComplainantBulkPdf(
  params: URLSearchParams,
  options: BulkPdfOptions
): Promise<Buffer> {
  const data = await getRepeatComplainantExportData(params);
  const ctx = createRepeatPdfDocument("تحليل تكرار الشكاوى", { orientation: "landscape" });
  const newPage = newPageFactory(ctx);

  let y = drawPageTitle(ctx, "تحليل تكرار الشكاوى من نفس الشخص", options.periodLabel);
  if (options.scopeLabel) {
    y = drawSectionHeading(ctx, options.scopeLabel, y);
  }
  if (options.includeFullIdentifier) {
    y = drawWarningBanner(ctx, PII_WARNING, y);
  }

  y = drawSectionHeading(ctx, "الملخص", y);
  const summaryLines = [
    `عدد الأشخاص المكررين: ${formatReportNumber(data.kpis.repeatedPeopleCount)}`,
    `إجمالي شكاواهم: ${formatReportNumber(data.kpis.repeatedComplaintsCount)}`,
    `نسبة الشكاوى المتكررة من إجمالي الفترة: ${formatReportNumber(data.kpis.repeatedShareOfPeriodPercent)}%`,
    data.kpis.topFacility
      ? `أكثر السجون تكراراً: ${data.kpis.topFacility.facility} (${formatReportNumber(data.kpis.topFacility.repeatedPeopleCount)} شخص)`
      : null,
    data.kpis.topComplaintType ? `أكثر أنواع الشكاوى تكراراً: ${data.kpis.topComplaintType.label}` : null,
  ].filter((line): line is string => line !== null);
  ctx.doc.font("Body").fontSize(11).fillColor("#073B31");
  for (const line of summaryLines) {
    ctx.doc.text(preparePdfText(line), ctx.margin, y, {
      width: ctx.contentWidth, align: "right", wordSpacing: 1,
    });
    y += 20;
  }

  ctx.doc.addPage();
  y = ctx.margin;
  y = drawSectionHeading(ctx, "أكثر السجون في تكرار الشكاوى", y);
  drawPaginatedTable<RepeatFacilitySummaryRow>({
    doc: ctx.doc,
    rows: data.facilities,
    columns: FACILITY_SUMMARY_COLUMNS,
    x: ctx.margin,
    y,
    width: ctx.contentWidth,
    bottomLimit: ctx.bottomLimit,
    newPage,
    formatCell: (row, key) => {
      if (key === "repeatedPeopleSharePercent") return `${formatReportNumber(row.repeatedPeopleSharePercent)}%`;
      if (key === "topComplaintType") return row.topComplaintType?.label ?? "—";
      return formatScalarCell((row as unknown as Record<string, unknown>)[key]);
    },
  });

  // Region -> facility grouped people sections (spec §6/§7/§17): a region
  // heading is drawn only when it differs from the previous section's
  // region — `data.facilitySections` is already sorted region ASC, then
  // facility repeatedPeopleCount DESC (see repeat-complainant-analytics-
  // service.ts's sortExportFacilitySections), so consecutive same-region
  // sections never repeat it.
  if (data.facilitySections.length > 0) {
    ctx.doc.addPage();
    y = ctx.margin;
    y = drawSectionHeading(ctx, "الأشخاص المكررون حسب السجن", y);

    let previousRegion: string | null = null;
    for (const section of data.facilitySections) {
      if (section.facility.region !== previousRegion) {
        if (wouldOverflow(ctx, y, 30 + FACILITY_SECTION_MIN_HEIGHT)) {
          y = newPage();
        }
        y = drawRegionHeading(ctx, section.facility.region, y);
        previousRegion = section.facility.region;
      }
      y = drawFacilitySection(ctx, section, y, options.includeFullIdentifier);
    }
  }

  drawFootersAndPageNumbers(ctx);
  ctx.doc.end();
  return ctx.done;
}
