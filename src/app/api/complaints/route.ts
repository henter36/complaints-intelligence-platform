import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { toComplaintListItem } from "@/lib/api-transformers";
import {
  addComplaintRequestFilters,
  buildComplaintWhereFromParams,
  InvalidComplaintQueryError,
  isInvalidComplaintQueryError,
} from "@/server/api/complaint-query";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const SORT_FIELDS = {
  receivedDate: "complaintDate",
  complaintDate: "complaintDate",
  dueDate: "dueDate",
  createdAt: "createdAt",
  priority: "priority",
  status: "status",
  severity: "severity",
  complaintNumber: "externalId",
} as const satisfies Record<string, keyof Prisma.ComplaintOrderByWithRelationInput>;

type ComplaintSortKey = keyof typeof SORT_FIELDS;
type ComplaintSortOrder = "asc" | "desc";

function parsePositiveInteger(
  value: string | null,
  fallback: number,
  fieldName: string
): number {
  if (value == null || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new InvalidComplaintQueryError(`${fieldName} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidComplaintQueryError(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

function parsePageSize(value: string | null): number {
  const pageSize = parsePositiveInteger(value, DEFAULT_PAGE_SIZE, "pageSize");
  if (pageSize > MAX_PAGE_SIZE) {
    throw new InvalidComplaintQueryError(`pageSize must not exceed ${MAX_PAGE_SIZE}`);
  }
  return pageSize;
}

function valueOrDefault(value: string | null, defaultValue: string): string {
  if (value == null || value === "") {
    return defaultValue;
  }

  return value;
}

function parseSortOrder(value: string | null = null): ComplaintSortOrder {
  const candidate = valueOrDefault(value, "desc");
  if (candidate === "asc" || candidate === "desc") return candidate;
  throw new InvalidComplaintQueryError("sortOrder must be asc or desc");
}

function parseSortBy(value: string | null = null): ComplaintSortKey {
  const candidate = valueOrDefault(value, "receivedDate");
  if (Object.prototype.hasOwnProperty.call(SORT_FIELDS, candidate)) {
    return candidate as ComplaintSortKey;
  }

  throw new InvalidComplaintQueryError("sortBy is not supported");
}

function calculateSkip(page: number, pageSize: number): number {
  const skip = (page - 1) * pageSize;
  if (!Number.isSafeInteger(skip)) {
    throw new InvalidComplaintQueryError("Requested page is outside the supported range");
  }
  return skip;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const page = parsePositiveInteger(url.searchParams.get("page"), DEFAULT_PAGE, "page");
    const pageSize = parsePageSize(url.searchParams.get("pageSize"));
    const sortBy = parseSortBy(url.searchParams.get("sortBy"));
    const sortOrder = parseSortOrder(url.searchParams.get("sortOrder"));
    const skip = calculateSkip(page, pageSize);

    const where: Prisma.ComplaintWhereInput = addComplaintRequestFilters(
      buildComplaintWhereFromParams(url.searchParams),
      url.searchParams
    );
    const sortField = SORT_FIELDS[sortBy];
    const orderBy: Prisma.ComplaintOrderByWithRelationInput[] = [
      { [sortField]: sortOrder },
      { id: sortOrder },
    ];

    const [complaints, total] = await Promise.all([
      db.complaint.findMany({
        where,
        select: {
          id: true,
          externalId: true,
          sourceReference: true,
          complaintDate: true,
          receivedAt: true,
          dueDate: true,
          closedAt: true,
          status: true,
          subject: true,
          description: true,
          region: true,
          facility: true,
          department: true,
          categoryId: true,
          classificationId: true,
          priority: true,
          severity: true,
          channel: true,
          resolution: true,
          firstActionAt: true,
          processingStartedAt: true,
          delayReason: true,
          isRepeated: true,
          isValidated: true,
          beneficiarySatisfaction: true,
          aiClassification: true,
          aiConfidence: true,
          aiReasoning: true,
          aiSentiment: true,
          aiSeverityScore: true,
          aiSummary: true,
          aiAnalyzedAt: true,
          isPotentialDuplicate: true,
          classification: { select: { nameAr: true, color: true } },
          category: { select: { nameAr: true } },
        },
        orderBy,
        skip,
        take: pageSize,
      }),
      db.complaint.count({ where }),
    ]);

    const now = new Date();
    const enriched = complaints.map(c => toComplaintListItem(c, now));

    const totalPages = Math.ceil(total / pageSize);
    return NextResponse.json({
      data: enriched,
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
    });
  } catch (error) {
    if (isInvalidComplaintQueryError(error)) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: 400 }
      );
    }
    console.error("Complaints API error:", error);
    return NextResponse.json({ error: "Failed to fetch complaints" }, { status: 500 });
  }
}
