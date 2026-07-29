import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { toComplaintListItem } from "@/lib/api-transformers";
import { buildComplaintWhereFromParams } from "@/server/api/complaint-query";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get("page") || "1");
    const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
    const search = url.searchParams.get("search") || "";
    const isLate = url.searchParams.get("isLate");
    const isRepeated = url.searchParams.get("isRepeated");
    const isValidated = url.searchParams.get("isValidated");
    const aiAnalyzed = url.searchParams.get("aiAnalyzed");
    const sortBy = url.searchParams.get("sortBy") || "receivedDate";
    const sortOrder = (url.searchParams.get("sortOrder") || "desc") as "asc" | "desc";

    const where: Prisma.ComplaintWhereInput = buildComplaintWhereFromParams(url.searchParams);
    if (search) {
      where.OR = [
        { externalId: { contains: search } },
        { sourceReference: { contains: search } },
        { subject: { contains: search } },
        { description: { contains: search } },
      ];
    }
    if (isRepeated === "true") where.isRepeated = true;
    if (isValidated === "true") where.isValidated = true;
    if (isValidated === "false") where.isValidated = false;
    if (aiAnalyzed === "true") where.aiAnalyzedAt = { not: null };
    if (aiAnalyzed === "false") where.aiAnalyzedAt = null;

    const sortMap: Record<string, keyof Prisma.ComplaintOrderByWithRelationInput> = {
      receivedDate: "complaintDate",
      complaintNumber: "externalId",
      status: "status",
      priority: "priority",
      severity: "severity",
    };
    const sortField = sortMap[sortBy] ?? "complaintDate";

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
          complainantName: true,
          complainantIdentifier: true,
          complainantPhone: true,
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
        orderBy: { [sortField]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.complaint.count({ where }),
    ]);

    const now = new Date();
    const enriched = complaints.map(c => toComplaintListItem(c, now));
    const filteredLate = isLate === "true" ? enriched.filter(c => c.isLate) : enriched;

    return NextResponse.json({
      data: filteredLate,
      total: isLate === "true" ? filteredLate.length : total,
      page,
      pageSize,
      totalPages: Math.ceil((isLate === "true" ? filteredLate.length : total) / pageSize),
    });
  } catch (error) {
    console.error("Complaints API error:", error);
    return NextResponse.json({ error: "Failed to fetch complaints" }, { status: 500 });
  }
}
