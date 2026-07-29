import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { toComplaintListItem } from "@/lib/api-transformers";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get("page") || "1");
    const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
    const search = url.searchParams.get("search") || "";
    const regionId = url.searchParams.get("regionId");
    const departmentId = url.searchParams.get("departmentId");
    const classificationId = url.searchParams.get("classificationId");
    const channel = url.searchParams.get("channel");
    const status = url.searchParams.get("status");
    const priority = url.searchParams.get("priority");
    const severity = url.searchParams.get("severity");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const isLate = url.searchParams.get("isLate");
    const isRepeated = url.searchParams.get("isRepeated");
    const isValidated = url.searchParams.get("isValidated");
    const aiAnalyzed = url.searchParams.get("aiAnalyzed");
    const sortBy = url.searchParams.get("sortBy") || "receivedDate";
    const sortOrder = (url.searchParams.get("sortOrder") || "desc") as "asc" | "desc";

    const where: Prisma.ComplaintWhereInput = {};
    if (search) {
      where.OR = [
        { complaintNumber: { contains: search } },
        { subject: { contains: search } },
        { description: { contains: search } },
      ];
    }
    if (regionId) where.regionId = regionId;
    if (departmentId) where.departmentId = departmentId;
    if (classificationId) where.classificationId = classificationId;
    if (channel) where.channel = channel;
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (severity) where.severity = severity;
    if (isRepeated === "true") where.isRepeated = true;
    if (isValidated === "true") where.isValidated = true;
    if (isValidated === "false") where.isValidated = false;
    if (aiAnalyzed === "true") where.aiAnalyzedAt = { not: null };
    if (aiAnalyzed === "false") where.aiAnalyzedAt = null;
    if (from || to) {
      where.receivedDate = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }

    const validSortFields = ["receivedDate", "complaintNumber", "status", "priority", "severity"];
    const sortField = validSortFields.includes(sortBy) ? sortBy : "receivedDate";

    const [complaints, total] = await Promise.all([
      db.complaint.findMany({
        where,
        include: {
          region: true,
          location: true,
          department: true,
          classification: true,
        },
        orderBy: { [sortField]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.complaint.count({ where }),
    ]);

    // Compute isLate for each
    const now = new Date();
    const enriched = complaints.map(c => toComplaintListItem(c, now));

    const filteredLate = isLate === "true"
      ? enriched.filter(c => c.isLate)
      : enriched;

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
