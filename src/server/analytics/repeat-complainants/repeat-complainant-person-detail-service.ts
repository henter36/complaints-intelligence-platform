import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildComplaintWhere,
  parseComplaintQuery,
} from "@/server/complaints/complaint-query-service";
import {
  buildCurrentOperationalFacilityWhere,
  combineComplaintWhere,
  isFacilityEventEligible,
  loadFacilityOperationalRegistry,
} from "@/server/facilities/facility-operational-scope-service";
import { decodeComplainantToken } from "@/server/complaints/complainant-token";
import {
  buildRepeatComplainantDirectory,
  isTechnicalDuplicate,
  type RepeatPersonRow,
} from "@/lib/analytics/repeat-complainant-directory";
import { classificationDisplayName, classificationKey } from "@/lib/reports/classification-keys";
import { displayRegionName, normalizeRegionName } from "@/lib/reports/region-normalization";
import { toClientPersonRow, type RepeatPersonRowForClient } from "./repeat-complainant-analytics-service";

const detailSelect = {
  id: true,
  externalId: true,
  sourceReference: true,
  complaintDate: true,
  receivedAt: true,
  region: true,
  facility: true,
  classificationId: true,
  classification: { select: { nameAr: true } },
  subject: true,
  description: true,
  status: true,
  complainantIdentifier: true,
  complainantName: true,
  isPotentialDuplicate: true,
  duplicateOfId: true,
} satisfies Prisma.ComplaintSelect;

type DetailRow = Prisma.ComplaintGetPayload<{ select: typeof detailSelect }>;

export type PersonComplaintRow = {
  complaintId: string;
  complaintNumber: string;
  date: string;
  region: string;
  facility: string;
  classificationId: string;
  classificationLabel: string;
  subject: string;
  descriptionSnippet: string | null;
  status: string;
  monthKey: string;
};

export type PersonComplaintTypeGroup = {
  classificationId: string;
  label: string;
  complaints: PersonComplaintRow[];
};

export type PersonTimelinePoint = { monthKey: string; monthLabel: string; count: number };

export type RepeatComplainantPersonDetail = {
  person: RepeatPersonRowForClient;
  complaints: PersonComplaintRow[];
  complaintsByType: PersonComplaintTypeGroup[];
  timeline: PersonTimelinePoint[];
};

const DESCRIPTION_SNIPPET_MAX = 160;

function effectiveDateOf(row: DetailRow): Date {
  return row.complaintDate ?? row.receivedAt;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

const ARABIC_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

function monthLabelOf(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) return monthKey;
  return `${ARABIC_MONTHS[month - 1]} ${year}`;
}

function snippet(description: string | null): string | null {
  if (!description) return null;
  const trimmed = description.trim();
  if (!trimmed) return null;
  return trimmed.length > DESCRIPTION_SNIPPET_MAX ? `${trimmed.slice(0, DESCRIPTION_SNIPPET_MAX)}…` : trimmed;
}

export type PersonDetailSortOrder = "desc" | "asc"; // newest-first (default) or oldest-first

/**
 * Full detail for ONE person — fetched only when their row is opened,
 * drilled through to, or exported (spec §18: never preload every person's
 * detail). `token` is resolved server-side; a malformed/foreign token
 * resolves to zero complaints rather than throwing, so a tampered URL fails
 * closed instead of leaking data or crashing.
 */
export async function getRepeatComplainantPersonDetail(
  token: string,
  facility: string,
  baseParams: URLSearchParams,
  now: Date = new Date(),
  sortOrder: PersonDetailSortOrder = "desc"
): Promise<RepeatComplainantPersonDetail | null> {
  const identifier = decodeComplainantToken(token);
  if (!identifier) return null;

  const query = parseComplaintQuery(baseParams);
  const [facilityWhere, facilityRegistry] = await Promise.all([
    buildCurrentOperationalFacilityWhere(),
    loadFacilityOperationalRegistry(),
  ]);
  const where: Prisma.ComplaintWhereInput = {
    ...combineComplaintWhere(buildComplaintWhere(query, now), facilityWhere),
    complainantIdentifier: identifier,
    facility,
  };
  const rows = await db.complaint.findMany({ select: detailSelect, where });

  const eligibleRows = rows.filter((row) => {
    if (!row.id) return false;
    return isFacilityEventEligible(facilityRegistry, row.facility, effectiveDateOf(row));
  });
  if (eligibleRows.length === 0) return null;

  // Reuse the SAME aggregation the summary/people lists use — never a
  // second, hand-rolled definition of totals/pattern/streak for this person.
  const directoryRecords = eligibleRows.map((row) => ({
    complaintId: row.id,
    complainantIdentifier: row.complainantIdentifier,
    complainantName: row.complainantName,
    region: row.region,
    facility: row.facility?.trim() || "غير محدد",
    classificationId: row.classificationId,
    classificationLabel: row.classification?.nameAr ?? null,
    effectiveDate: toIsoDate(effectiveDateOf(row)),
    isPotentialDuplicate: row.isPotentialDuplicate,
    duplicateOfId: row.duplicateOfId,
  }));
  const directory = buildRepeatComplainantDirectory(directoryRecords, directoryRecords.length, undefined, {
    minComplaintsPerPerson: 1,
  });
  const personRow: RepeatPersonRow | undefined = directory.people[0];
  if (!personRow) return null;

  const realComplaints = eligibleRows.filter((row) => !isTechnicalDuplicate(row));
  const complaints: PersonComplaintRow[] = realComplaints
    .map((row) => {
      const date = toIsoDate(effectiveDateOf(row));
      const key = classificationKey(row.classificationId);
      return {
        complaintId: row.id,
        complaintNumber: row.externalId ?? row.sourceReference ?? row.id,
        date,
        region: displayRegionName(normalizeRegionName(row.region)),
        facility: row.facility?.trim() || "غير محدد",
        classificationId: key,
        classificationLabel: classificationDisplayName(row.classification?.nameAr),
        subject: row.subject,
        descriptionSnippet: snippet(row.description),
        status: row.status,
        monthKey: monthKeyOf(date),
      };
    })
    .sort((a, b) => (sortOrder === "desc" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)));

  const byType = new Map<string, PersonComplaintTypeGroup>();
  for (const complaint of complaints) {
    const group = byType.get(complaint.classificationId) ?? {
      classificationId: complaint.classificationId,
      label: complaint.classificationLabel,
      complaints: [],
    };
    group.complaints.push(complaint);
    byType.set(complaint.classificationId, group);
  }
  const complaintsByType = [...byType.values()].sort((a, b) => b.complaints.length - a.complaints.length);

  const monthCounts = new Map<string, number>();
  for (const complaint of complaints) {
    monthCounts.set(complaint.monthKey, (monthCounts.get(complaint.monthKey) ?? 0) + 1);
  }
  const timeline: PersonTimelinePoint[] = [...monthCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthKey, count]) => ({ monthKey, monthLabel: monthLabelOf(monthKey), count }));

  return {
    person: toClientPersonRow(personRow),
    complaints,
    complaintsByType,
    timeline,
  };
}
