import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// POST /api/ai/approve
// Body: {
//   complaintId: string;
//   action: "approve" | "modify" | "dismiss";
//   modifiedClassification?: string;
//   modifiedSeverity?: "low" | "medium" | "high" | "critical";
//   modifiedPriority?: "low" | "medium" | "high" | "critical";
//   notes?: string;
// }
//
// The AI is an assistant: this endpoint records the user's final decision.
// It does NOT auto-apply AI suggestions. The user explicitly chooses what to apply.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "صيغة الطلب غير صالحة" },
        { status: 400 }
      );
    }

    const { complaintId, action } = body as {
      complaintId?: string;
      action?: string;
    };

    if (!complaintId || typeof complaintId !== "string") {
      return NextResponse.json(
        { error: "معرف الشكوى مطلوب" },
        { status: 400 }
      );
    }

    const complaint = await db.complaint.findUnique({
      where: { id: complaintId },
    });
    if (!complaint) {
      return NextResponse.json(
        { error: "الشكوى غير موجودة" },
        { status: 404 }
      );
    }

    const validActions = ["approve", "modify", "dismiss"];
    if (!action || !validActions.includes(action)) {
      return NextResponse.json(
        { error: "إجراء غير صالح" },
        { status: 400 }
      );
    }

    const historyEntries: Array<{
      field: string;
      oldValue: string | null;
      newValue: string;
      changeType: string;
    }> = [];

    if (action === "approve") {
      // Apply AI suggestion as user-confirmed decision (only classification
      // and severity, which are user-approved fields)
      if (complaint.aiClassification) {
        historyEntries.push({
          field: "classification",
          oldValue: complaint.classificationId,
          newValue: complaint.aiClassification,
          changeType: "ai_suggestion",
        });
        // Try to find a matching classification by name; if not found, leave
        // classificationId unchanged and just keep the AI suggestion as a tag.
        const match = await db.classification.findFirst({
          where: { name: complaint.aiClassification },
        });
        if (match) {
          await db.complaint.update({
            where: { id: complaintId },
            data: { classificationId: match.id },
          });
        }
      }
      historyEntries.push({
        field: "ai_decision",
        oldValue: null,
        newValue: "approved",
        changeType: "ai_suggestion",
      });
    } else if (action === "modify") {
      // Apply user-modified values (override the AI suggestion)
      const modifiedClassification = body.modifiedClassification as
        | string
        | undefined;
      const modifiedSeverity = body.modifiedSeverity as
        | string
        | undefined;
      const modifiedPriority = body.modifiedPriority as
        | string
        | undefined;

      const updateData: Record<string, unknown> = {};
      if (
        modifiedClassification &&
        typeof modifiedClassification === "string"
      ) {
        const match = await db.classification.findFirst({
          where: { name: modifiedClassification },
        });
        if (match) {
          updateData.classificationId = match.id;
          historyEntries.push({
            field: "classification",
            oldValue: complaint.classificationId,
            newValue: match.id,
            changeType: "ai_suggestion",
          });
        }
      }
      if (
        modifiedSeverity &&
        ["low", "medium", "high", "critical"].includes(modifiedSeverity)
      ) {
        updateData.severity = modifiedSeverity;
        historyEntries.push({
          field: "severity",
          oldValue: complaint.severity,
          newValue: modifiedSeverity,
          changeType: "ai_suggestion",
        });
      }
      if (
        modifiedPriority &&
        ["low", "medium", "high", "critical"].includes(modifiedPriority)
      ) {
        updateData.priority = modifiedPriority;
        historyEntries.push({
          field: "priority",
          oldValue: complaint.priority,
          newValue: modifiedPriority,
          changeType: "ai_suggestion",
        });
      }

      if (Object.keys(updateData).length > 0) {
        await db.complaint.update({
          where: { id: complaintId },
          data: updateData,
        });
      }
      historyEntries.push({
        field: "ai_decision",
        oldValue: null,
        newValue: "modified",
        changeType: "ai_suggestion",
      });
    } else {
      // dismiss
      historyEntries.push({
        field: "ai_decision",
        oldValue: null,
        newValue: "dismissed",
        changeType: "ai_suggestion",
      });
    }

    // Persist history entries
    if (historyEntries.length > 0) {
      try {
        await db.complaintHistory.createMany({
          data: historyEntries.map((h) => ({
            complaintId,
            field: h.field,
            oldValue: h.oldValue ?? null,
            newValue: h.newValue,
            changeType: h.changeType,
          })),
        });
      } catch {
        // non-fatal
      }
    }

    return NextResponse.json({
      success: true,
      action,
      complaintId,
      message:
        action === "approve"
          ? "تم اعتماد اقتراح الذكاء الاصطناعي وتطبيقه على الشكوى"
          : action === "modify"
          ? "تم تطبيق التعديلات اليدوية على الشكوى"
          : "تم تجاهل اقتراح الذكاء الاصطناعي",
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "خطأ غير معروف";
    console.error("AI approve route error:", msg);
    return NextResponse.json(
      { error: `فشل الإجراء: ${msg}` },
      { status: 500 }
    );
  }
}
