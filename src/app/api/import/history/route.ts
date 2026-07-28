import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const batches = await db.importBatch.findMany({
      include: {
        uploadedBy: { select: { name: true, email: true } },
        approvedBy: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(batches);
  } catch (error) {
    console.error("Import history error:", error);
    return NextResponse.json({ error: "Failed to fetch import history" }, { status: 500 });
  }
}
