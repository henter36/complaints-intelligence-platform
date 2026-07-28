import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const classifications = await db.classification.findMany({
      where: { parentId: null },
      include: {
        children: true,
      },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(classifications);
  } catch (error) {
    console.error("Classifications API error:", error);
    return NextResponse.json({ error: "Failed to fetch classifications" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, description, color, keywords, parentId } = body;

    const classification = await db.classification.create({
      data: {
        name,
        description,
        color: color || "#64748b",
        keywords: keywords ? JSON.stringify(keywords) : null,
        parentId: parentId || null,
      },
    });

    return NextResponse.json(classification, { status: 201 });
  } catch (error) {
    console.error("Create classification error:", error);
    return NextResponse.json({ error: "Failed to create classification" }, { status: 500 });
  }
}
