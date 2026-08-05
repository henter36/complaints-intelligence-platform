import { NextRequest, NextResponse } from "next/server";
import { ComplaintPriority, ComplaintStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

function optionFromName(name: string) {
  return { id: name, name };
}

const compareArabicLabels = (left: string, right: string): number => left.localeCompare(right, "ar");

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const [regionRows, departmentRows, facilityRows, categories, channels, sourceOrigins, sourceStatuses, sourceActionStatuses, wingCodes] = await Promise.all([
      db.complaint.findMany({
        where: { isDeleted: false, region: { not: null } },
        select: { region: true },
        distinct: ["region"],
      }),
      db.complaint.findMany({
        where: { isDeleted: false, department: { not: null } },
        select: { department: true },
        distinct: ["department"],
      }),
      db.complaint.findMany({
        where: { isDeleted: false, facility: { not: null } },
        select: { facility: true, region: true },
        distinct: ["facility"],
      }),
      db.category.findMany({
        where: { isDeleted: false, isActive: true },
        include: {
          classifications: {
            where: { isDeleted: false, isActive: true },
            orderBy: [{ displayOrder: "asc" }, { nameAr: "asc" }],
          },
        },
        orderBy: [{ displayOrder: "asc" }, { nameAr: "asc" }],
      }),
      db.complaint.findMany({
        where: { isDeleted: false, channel: { not: null } },
        select: { channel: true },
        distinct: ["channel"],
      }),
      db.complaint.findMany({
        where: { isDeleted: false, sourceOrigin: { not: null } },
        select: { sourceOrigin: true },
        distinct: ["sourceOrigin"],
      }),
      db.complaint.findMany({
        where: { isDeleted: false, sourceStatus: { not: null } },
        select: { sourceStatus: true },
        distinct: ["sourceStatus"],
      }),
      db.complaint.findMany({
        where: { isDeleted: false, sourceActionStatus: { not: null } },
        select: { sourceActionStatus: true },
        distinct: ["sourceActionStatus"],
      }),
      db.complaint.findMany({
        where: { isDeleted: false, wingCode: { not: null } },
        select: { wingCode: true },
        distinct: ["wingCode"],
      }),
    ]);

    const unspecified = { id: "__UNSPECIFIED__", name: "غير محدد" };

    return NextResponse.json({
      regions: regionRows.flatMap(r => r.region ? [optionFromName(r.region)] : []).sort((a, b) => compareArabicLabels(a.name, b.name)),
      departments: departmentRows.flatMap(d => d.department ? [optionFromName(d.department)] : []).sort((a, b) => compareArabicLabels(a.name, b.name)),
      facilities: facilityRows.flatMap(f => f.facility ? [{ id: f.facility, name: f.facility, regionId: f.region }] : []).sort((a, b) => compareArabicLabels(a.name, b.name)),
      locations: facilityRows.flatMap(f => f.facility ? [{ id: f.facility, name: f.facility, regionId: f.region }] : []).sort((a, b) => compareArabicLabels(a.name, b.name)),
      categories: categories.map(category => ({ id: category.id, name: category.nameAr })),
      classifications: categories.map(category => ({
        id: category.id,
        name: category.nameAr,
        color: "#64748b",
        children: category.classifications.map(classification => ({
          id: classification.id,
          name: classification.nameAr,
          color: classification.color,
        })),
      })),
      statuses: Object.values(ComplaintStatus),
      priorities: Object.values(ComplaintPriority),
      channels: channels.flatMap(c => c.channel ? [c.channel] : []).sort(compareArabicLabels),
      sourceOrigins: [
        unspecified,
        ...sourceOrigins
          .flatMap((r) => (r.sourceOrigin?.trim() ? [optionFromName(r.sourceOrigin.trim())] : []))
          .sort((a, b) => compareArabicLabels(a.name, b.name)),
      ],
      sourceStatuses: [
        unspecified,
        ...sourceStatuses
          .flatMap((r) => (r.sourceStatus?.trim() ? [optionFromName(r.sourceStatus.trim())] : []))
          .sort((a, b) => compareArabicLabels(a.name, b.name)),
      ],
      sourceActionStatuses: [
        unspecified,
        ...sourceActionStatuses
          .flatMap((r) =>
            r.sourceActionStatus?.trim() ? [optionFromName(r.sourceActionStatus.trim())] : []
          )
          .sort((a, b) => compareArabicLabels(a.name, b.name)),
      ],
      wingCodes: [
        unspecified,
        ...wingCodes
          .flatMap((r) => (r.wingCode?.trim() ? [optionFromName(r.wingCode.trim())] : []))
          .sort((a, b) => compareArabicLabels(a.name, b.name))
          .slice(0, 500),
      ],
      dataFreshnessBuckets: [
        { id: "fresh_1d", name: "خلال يوم" },
        { id: "stale_1_3d", name: "1–3 أيام" },
        { id: "stale_3_7d", name: "3–7 أيام" },
        { id: "stale_7d_plus", name: "أكثر من 7 أيام" },
        { id: "missing", name: "بلا تاريخ تحديث" },
      ],
    });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    console.error("Filters API error:", error);
    return NextResponse.json({ error: "Failed to fetch filters" }, { status: 500 });
  }
}
