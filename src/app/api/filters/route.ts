import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const [regions, departments, locations, classifications, channels] = await Promise.all([
      db.region.findMany({ orderBy: { name: "asc" } }),
      db.department.findMany({ orderBy: { name: "asc" } }),
      db.location.findMany({ include: { region: true }, orderBy: { name: "asc" } }),
      db.classification.findMany({
        where: { parentId: null },
        include: { children: true },
        orderBy: { name: "asc" },
      }),
      db.complaint.findMany({
        select: { channel: true },
        distinct: ["channel"],
      }),
    ]);

    return NextResponse.json({
      regions,
      departments,
      locations,
      classifications,
      channels: channels.map(c => c.channel),
    });
  } catch (error) {
    console.error("Filters API error:", error);
    return NextResponse.json({ error: "Failed to fetch filters" }, { status: 500 });
  }
}
