import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const categories = await db.category.findMany({
      where: { isDeleted: false },
      include: {
        classifications: {
          where: { isDeleted: false },
          orderBy: [{ displayOrder: "asc" }, { nameAr: "asc" }],
        },
      },
      orderBy: [{ displayOrder: "asc" }, { nameAr: "asc" }],
    });

    return NextResponse.json(categories.map(category => ({
      id: category.id,
      name: category.nameAr,
      nameEn: category.nameEn,
      description: category.description,
      color: "#64748b",
      keywords: null,
      parentId: null,
      children: category.classifications.map(classification => ({
        id: classification.id,
        name: classification.nameAr,
        nameEn: classification.nameEn,
        description: classification.description,
        color: classification.color,
        keywords: classification.keywords,
        parentId: category.id,
      })),
    })));
  } catch (error) {
    console.error("Classifications API error:", error);
    return NextResponse.json({ error: "Failed to fetch classifications" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, description, color, keywords, parentId } = body;

    if (parentId) {
      const classification = await db.classification.create({
        data: {
          categoryId: parentId,
          nameAr: name,
          description,
          color: color || "#64748b",
          keywords: keywords ?? undefined,
        },
      });
      return NextResponse.json({
        ...classification,
        name: classification.nameAr,
        parentId: classification.categoryId,
      }, { status: 201 });
    }

    const category = await db.category.create({
      data: {
        nameAr: name,
        description,
      },
    });
    return NextResponse.json({
      ...category,
      name: category.nameAr,
      color: "#64748b",
      parentId: null,
    }, { status: 201 });
  } catch (error) {
    console.error("Create classification error:", error);
    return NextResponse.json({ error: "Failed to create classification" }, { status: 500 });
  }
}
