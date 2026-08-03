import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { parseClassificationKeywords } from "@/server/classifications/classification-keywords";

type ClassificationRequestBody = {
  id?: string | null;
  name: string;
  description?: string | null;
  color?: string | null;
  keywords?: Prisma.InputJsonValue | null;
  parentId?: string | null;
};

function invalidParentResponse(
  parentId: string | null | undefined,
  normalizedParentId: string
): NextResponse | null {
  if (parentId == null || normalizedParentId.length > 0) return null;

  return NextResponse.json(
    { error: "INVALID_PARENT_CATEGORY", message: "parentId must reference an active category." },
    { status: 400 }
  );
}

function invalidKeywordsResponse(keywords: Prisma.InputJsonValue | null | undefined): NextResponse | null {
  if (keywords === undefined || keywords === null) return null;

  try {
    parseClassificationKeywords(keywords);
    return null;
  } catch {
    return NextResponse.json(
      { error: "INVALID_CLASSIFICATION_KEYWORDS", message: "يجب أن تكون الكلمات المفتاحية قائمة من النصوص." },
      { status: 400 }
    );
  }
}

async function createOrUpdateClassification(
  body: ClassificationRequestBody,
  parentCategoryId: string
): Promise<NextResponse> {
  const data = {
    categoryId: parentCategoryId,
    nameAr: body.name,
    description: body.description,
    color: body.color || "#64748b",
    keywords: body.keywords ?? undefined,
  };
  const normalizedId = typeof body.id === "string" ? body.id.trim() : "";
  const classification = normalizedId
    ? await db.classification.update({ where: { id: normalizedId }, data })
    : await db.classification.create({ data });

  return NextResponse.json({
    ...classification,
    name: classification.nameAr,
    parentId: classification.categoryId,
  }, { status: 201 });
}

async function createClassificationOrCategory(
  body: ClassificationRequestBody,
  normalizedParentId: string
): Promise<NextResponse> {
  if (!normalizedParentId) {
    const category = await db.category.create({
      data: {
        nameAr: body.name,
        description: body.description,
      },
    });
    return NextResponse.json({
      ...category,
      name: category.nameAr,
      color: "#64748b",
      parentId: null,
    }, { status: 201 });
  }

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

  return createOrUpdateClassification(body, parentCategory.id);
}

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
    const body = await req.json() as ClassificationRequestBody;
    const normalizedParentId = typeof body.parentId === "string" ? body.parentId.trim() : "";

    const parentError = invalidParentResponse(body.parentId, normalizedParentId);
    if (parentError) return parentError;

    const keywordsError = invalidKeywordsResponse(body.keywords);
    if (keywordsError) return keywordsError;

    return createClassificationOrCategory(body, normalizedParentId);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    console.error("Create classification error:", error);
    return NextResponse.json({ error: "Failed to create classification" }, { status: 500 });
  }
}
