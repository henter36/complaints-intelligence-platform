import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { parseClassificationKeywords } from "@/server/classifications/classification-keywords";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
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
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    console.error("Classifications API error:", error);
    return NextResponse.json({ error: "Failed to fetch classifications" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const body = await req.json();
    const { id, name, description, color, keywords, parentId } = body;
    const normalizedParentId = typeof parentId === "string" ? parentId.trim() : "";

    if (parentId != null && normalizedParentId.length === 0) {
      return NextResponse.json(
        { error: "INVALID_PARENT_CATEGORY", message: "parentId must reference an active category." },
        { status: 400 }
      );
    }

    if (keywords !== undefined && keywords !== null) {
      try {
        parseClassificationKeywords(keywords);
      } catch {
        return NextResponse.json(
          { error: "INVALID_CLASSIFICATION_KEYWORDS", message: "يجب أن تكون الكلمات المفتاحية قائمة من النصوص." },
          { status: 400 }
        );
      }
    }

    if (normalizedParentId) {
      const parentCategory = await db.category.findFirst({
        where: {
          id: normalizedParentId,
          isDeleted: false,
        },
        select: { id: true },
      });

      if (!parentCategory) {
        return NextResponse.json(
          { error: "CATEGORY_NOT_FOUND", message: "Parent category was not found or is inactive." },
          { status: 404 }
        );
      }

      const classification = typeof id === "string" && id.trim()
        ? await db.classification.update({
            where: { id: id.trim() },
            data: {
              categoryId: parentCategory.id,
              nameAr: name,
              description,
              color: color || "#64748b",
              keywords: keywords ?? undefined,
            },
          })
        : await db.classification.create({
            data: {
              categoryId: parentCategory.id,
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
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    console.error("Create classification error:", error);
    return NextResponse.json({ error: "Failed to create classification" }, { status: 500 });
  }
}
