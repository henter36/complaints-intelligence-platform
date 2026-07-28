import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import ZAI from "z-ai-web-dev-sdk";

// AI analysis result type
interface AiAnalysisResult {
  proposedClassification: string;
  confidence: number; // 0-1
  reasoning: string;
  sentiment: "positive" | "neutral" | "negative" | "very_negative";
  severityScore: number; // 0-100
  summary: string;
  keywords?: string[];
}

// Known classification catalog (Arabic)
const CLASSIFICATION_CATALOG = [
  "جودة الخدمة الطبية",
  "تأخر العلاج",
  "خطأ طبي",
  "عدم استجابة الطاقم",
  "المواعيد والانتظار",
  "تأخر المواعيد",
  "إلغاء الموعد",
  "صعوبة الحجز",
  "المنشآت والمعدات",
  "تعطل الأجهزة",
  "نقص المعدات",
  "صيانة الأبنية",
  "النظافة والبيئة",
  "نظافة المرافق",
  "الروائح",
  "المياه والصرف",
  "السلوك المهني",
  "سوء المعاملة",
  "عدم الالتزام",
  "التمييز",
  "الفوترة والرسوم",
  "فواتير خاطئة",
  "رسوم مبالغ فيها",
  "تأخر رد المبالغ",
  "الصيدلية والأدوية",
  "نقص الأدوية",
  "تأخر الصرف",
  "أدوية منتهية",
  "المختبرات والأشعة",
  "تأخر النتائج",
  "نتائج خاطئة",
  "صعوبة حجز الأشعة",
];

const SYSTEM_PROMPT = `أنت مساعد ذكي متخصص في تحليل نصوص شكاوى المرافق الصحية في المملكة العربية السعودية.
مهمتك هي تحليل كل شكوى وتقديم اقتراحات مساعدة (وليست قرارات نهائية).

يجب عليك إرجاع النتيجة بصيغة JSON صالحة فقط دون أي نص إضافي قبلها أو بعدها.

الصيغة المطلوبة:
{
  "proposedClassification": "أحد التصنيفات من القائمة أدناه",
  "confidence": 0.0 إلى 1.0,
  "reasoning": "شرح موجز لسبب اختيار هذا التصنيف باللغة العربية",
  "sentiment": "positive | neutral | negative | very_negative",
  "severityScore": رقم من 0 إلى 100,
  "summary": "ملخص مكثف للشكوى في جملة أو جملتين باللغة العربية",
  "keywords": ["كلمة مفتاحية 1", "كلمة مفتاحية 2"]
}

قائمة التصنيفات المسموح بها:
${CLASSIFICATION_CATALOG.map((c, i) => `${i + 1}. ${c}`).join("\n")}

قواعد التحليل:
- confidence: درجة ثقتك في التصنيف المقترح (0-1). استخدم >0.8 فقط إذا كان التصنيف واضحاً جداً من النص.
- sentiment: المشاعر المستخلصة من نص الشكوى. very_negative للغضب الشديد/الإهانة، negative للتذمر، neutral للوصف المجرد.
- severityScore: درجة الخطورة من 0-100. ارفع الدرجة إذا تضمنت الشكوى: خطر على حياة المريض، خطأ طبي، تأخر طويل في الطوارئ، تفرقة تمييزية.
- summary: ملخص قصير ومركّز.
- keywords: 2-5 كلمات مفتاحية تمثل محاور الشكوى.
- جميع النصوص (reasoning, summary, keywords) يجب أن تكون باللغة العربية الفصحى.

مهم: النتيجة JSON صالحة فقط، بدون أي علامات markdown مثل \`\`\`json.`;

function buildUserPrompt(complaint: {
  complaintNumber: string;
  subject: string;
  description: string;
  channel?: string;
  region?: { name: string } | null;
  department?: { name: string } | null;
  classification?: { name: string } | null;
}): string {
  const parts: string[] = [];
  parts.push(`رقم الشكوى: ${complaint.complaintNumber}`);
  if (complaint.region?.name) parts.push(`المنطقة: ${complaint.region.name}`);
  if (complaint.department?.name) parts.push(`الإدارة: ${complaint.department.name}`);
  if (complaint.channel) parts.push(`قناة الاستلام: ${complaint.channel}`);
  if (complaint.classification?.name) parts.push(`التصنيف الحالي (مرجعي): ${complaint.classification.name}`);
  parts.push(`الموضوع: ${complaint.subject}`);
  parts.push(`الوصف: ${complaint.description}`);
  return `حلّل الشكوى التالية وأرجع النتيجة بصيغة JSON فقط:\n\n${parts.join("\n")}`;
}

function extractJson(raw: string): AiAnalysisResult | null {
  if (!raw) return null;
  let text = raw.trim();
  // Remove potential markdown code fences
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // Try to locate the JSON object boundaries
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonStr = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as AiAnalysisResult;
  } catch {
    return null;
  }
}

function sanitizeResult(result: AiAnalysisResult): AiAnalysisResult {
  const confidence =
    typeof result.confidence === "number"
      ? Math.min(1, Math.max(0, result.confidence))
      : 0.5;
  const severityScore =
    typeof result.severityScore === "number"
      ? Math.min(100, Math.max(0, result.severityScore))
      : 50;
  const validSentiments = ["positive", "neutral", "negative", "very_negative"];
  const sentiment = validSentiments.includes(result.sentiment)
    ? (result.sentiment as AiAnalysisResult["sentiment"])
    : "neutral";
  const proposedClassification =
    typeof result.proposedClassification === "string" && result.proposedClassification.trim()
      ? result.proposedClassification.trim()
      : "غير مصنف";
  const reasoning =
    typeof result.reasoning === "string" && result.reasoning.trim()
      ? result.reasoning.trim()
      : "لم يقدم النموذج تفسيراً.";
  const summary =
    typeof result.summary === "string" && result.summary.trim()
      ? result.summary.trim()
      : "";
  const keywords = Array.isArray(result.keywords)
    ? result.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).slice(0, 8)
    : [];
  return {
    proposedClassification,
    confidence,
    reasoning,
    sentiment,
    severityScore,
    summary,
    keywords,
  };
}

async function analyzeComplaint(
  complaintId: string
): Promise<{ success: boolean; complaintId: string; error?: string; result?: AiAnalysisResult }> {
  try {
    const complaint = await db.complaint.findUnique({
      where: { id: complaintId },
      include: { region: true, department: true, classification: true },
    });
    if (!complaint) {
      return { success: false, complaintId, error: "الشكوى غير موجودة" };
    }

    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(complaint) },
      ],
      thinking: { type: "disabled" },
    });

    const rawContent: string =
      completion?.choices?.[0]?.message?.content ?? "";

    const extracted = extractJson(rawContent);
    if (!extracted) {
      return {
        success: false,
        complaintId,
        error: "تعذر تحليل استجابة الذكاء الاصطناعي",
      };
    }

    const sanitized = sanitizeResult(extracted);

    await db.complaint.update({
      where: { id: complaintId },
      data: {
        aiClassification: sanitized.proposedClassification,
        aiConfidence: sanitized.confidence,
        aiReasoning: sanitized.reasoning,
        aiSentiment: sanitized.sentiment,
        aiSeverityScore: sanitized.severityScore,
        aiSummary: sanitized.summary,
        aiAnalyzedAt: new Date(),
      },
    });

    // Log to history (best-effort)
    try {
      await db.complaintHistory.create({
        data: {
          complaintId,
          field: "ai_analysis",
          newValue: JSON.stringify(sanitized),
          changeType: "ai_suggestion",
        },
      });
    } catch {
      // non-fatal
    }

    return { success: true, complaintId, result: sanitized };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "خطأ غير معروف";
    console.error(`AI analyze error for ${complaintId}:`, msg);
    return { success: false, complaintId, error: msg };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "صيغة الطلب غير صالحة" },
        { status: 400 }
      );
    }

    let complaintIds: string[] = [];
    if (Array.isArray(body.complaintIds)) {
      complaintIds = body.complaintIds.filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0
      );
    } else if (typeof body.complaintId === "string") {
      complaintIds = [body.complaintId];
    }

    if (complaintIds.length === 0) {
      return NextResponse.json(
        { error: "لم يتم اختيار أي شكوى للتحليل" },
        { status: 400 }
      );
    }

    // Limit batch size to keep response time reasonable
    const MAX_BATCH = 10;
    const batch = complaintIds.slice(0, MAX_BATCH);

    const results = await Promise.all(
      batch.map((id) => analyzeComplaint(id))
    );

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Fetch updated complaints for the successful ones
    const updatedComplaints =
      succeeded.length > 0
        ? await db.complaint.findMany({
            where: { id: { in: succeeded.map((r) => r.complaintId) } },
            include: {
              region: true,
              location: true,
              department: true,
              classification: true,
            },
          })
        : [];

    return NextResponse.json({
      success: true,
      analyzed: succeeded.length,
      failed: failed.length,
      results: results.map((r) => ({
        complaintId: r.complaintId,
        success: r.success,
        error: r.error,
        result: r.result,
      })),
      complaints: updatedComplaints,
      message:
        failed.length === 0
          ? `تم تحليل ${succeeded.length} شكوى بنجاح`
          : `تم تحليل ${succeeded.length} بنجاح وفشل ${failed.length}`,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "خطأ غير معروف";
    console.error("AI analyze route error:", msg);
    return NextResponse.json(
      { error: `فشل التحليل: ${msg}` },
      { status: 500 }
    );
  }
}

// Helper for client to know which classifications AI may suggest
export async function GET() {
  return NextResponse.json({
    classifications: CLASSIFICATION_CATALOG,
    sentiments: ["positive", "neutral", "negative", "very_negative"],
  });
}
