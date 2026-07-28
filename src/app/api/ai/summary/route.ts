import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import ZAI from "z-ai-web-dev-sdk";

// POST /api/ai/summary
// Body: { complaintIds?: string[] } OR {} (uses all analyzed complaints)
// Returns an AI-generated executive summary in Arabic based on the
// aggregated analysis results.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ids = Array.isArray(body?.complaintIds)
      ? body.complaintIds.filter(
          (id: unknown): id is string => typeof id === "string" && id.trim().length > 0
        )
      : null;

    const analyzed = await db.complaint.findMany({
      where: ids && ids.length > 0
        ? { id: { in: ids }, aiAnalyzedAt: { not: null } }
        : { aiAnalyzedAt: { not: null } },
      select: {
        complaintNumber: true,
        subject: true,
        aiClassification: true,
        aiConfidence: true,
        aiSentiment: true,
        aiSeverityScore: true,
        aiSummary: true,
      },
      take: 50,
      orderBy: { aiAnalyzedAt: "desc" },
    });

    if (analyzed.length === 0) {
      return NextResponse.json({
        success: true,
        summary: "لا توجد شكاوى محللة لإنشاء ملخص تنفيذي.",
        count: 0,
      });
    }

    // Build a compact snapshot for the AI
    const sentimentCounts: Record<string, number> = {};
    let highSeverity = 0;
    let totalConfidence = 0;
    const classCounts: Record<string, number> = {};
    for (const c of analyzed) {
      const s = c.aiSentiment || "neutral";
      sentimentCounts[s] = (sentimentCounts[s] || 0) + 1;
      if ((c.aiSeverityScore ?? 0) >= 70) highSeverity += 1;
      totalConfidence += c.aiConfidence ?? 0;
      const cls = c.aiClassification || "غير مصنف";
      classCounts[cls] = (classCounts[cls] || 0) + 1;
    }
    const topClasses = Object.entries(classCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count})`)
      .join("، ");

    const snapshot = {
      total: analyzed.length,
      sentiments: sentimentCounts,
      highSeverity,
      avgConfidence: +(totalConfidence / analyzed.length).toFixed(2),
      topClasses,
      samples: analyzed.slice(0, 12).map((c) => ({
        number: c.complaintNumber,
        subject: c.subject,
        classification: c.aiClassification,
        sentiment: c.aiSentiment,
        severity: c.aiSeverityScore,
        summary: c.aiSummary,
      })),
    };

    const systemPrompt = `أنت محلل بيانات ذكي متخصص في المرافق الصحية. مهمتك إنشاء ملخص تنفيذي موجز ومركّز باللغة العربية الفصحى بناءً على بيانات تحليل شكاوى.
الملخص يجب أن:
- يبدأ بفقرة افتتاحية توضح العدد الإجمالي للشكاوى المحللة ومستوى الثقة.
- يذكر أبرز التصنيفات المتكررة.
- يلخص توزيع المشاعر.
- يسلط الضوء على الشكاوى ذات الخطورة العالية.
- ينتهي بتوصيات عامة للجهات المعنية (بدون قرارات إلزامية).
- لا يتجاوز 250 كلمة.
- يكتب كنص عادي بدون رموز markdown.`;

    const userPrompt = `أنشئ ملخصاً تنفيذياً بناءً على البيانات التالية (بصيغة JSON):\n${JSON.stringify(snapshot, null, 2)}`;

    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      thinking: { type: "disabled" },
    });

    const summary: string =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "تعذّر توليد الملخص التنفيذي.";

    return NextResponse.json({
      success: true,
      summary,
      count: analyzed.length,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "خطأ غير معروف";
    console.error("AI summary route error:", msg);
    return NextResponse.json(
      { error: `فشل توليد الملخص: ${msg}` },
      { status: 500 }
    );
  }
}
