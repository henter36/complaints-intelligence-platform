import { NextResponse } from "next/server";
import { db } from "@/lib/db";

function optionFromName(name: string) {
  return { id: name, name };
}

export async function GET() {
  try {
    const [regionRows, departmentRows, facilityRows, categories, channels] = await Promise.all([
      db.complaint.findMany({
        where: { isDeleted: false, region: { not: null } },
        select: { region: true },
        distinct: ["region"],
        orderBy: { region: "asc" },
      }),
      db.complaint.findMany({
        where: { isDeleted: false, department: { not: null } },
        select: { department: true },
        distinct: ["department"],
        orderBy: { department: "asc" },
      }),
      db.complaint.findMany({
        where: { isDeleted: false, facility: { not: null } },
        select: { facility: true, region: true },
        distinct: ["facility"],
        orderBy: { facility: "asc" },
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
    ]);

    return NextResponse.json({
      regions: regionRows.flatMap(r => r.region ? [optionFromName(r.region)] : []),
      departments: departmentRows.flatMap(d => d.department ? [optionFromName(d.department)] : []),
      locations: facilityRows.flatMap(f => f.facility ? [{ id: f.facility, name: f.facility, regionId: f.region }] : []),
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
      channels: channels.flatMap(c => c.channel ? [c.channel] : []),
    });
  } catch (error) {
    console.error("Filters API error:", error);
    return NextResponse.json({ error: "Failed to fetch filters" }, { status: 500 });
  }
}
