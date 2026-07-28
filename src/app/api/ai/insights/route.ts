import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET /api/ai/insights
// Returns aggregated batch insights computed from complaints that have been
// analyzed by AI (aiAnalyzedAt != null).
//
// Returns:
//   - sentimentDistribution
//   - severityBuckets (low / medium / high / critical based on score)
//   - topClassifications (proposed AI classifications)
//   - topKeywords (most common keywords extracted from summaries + subjects)
//   - recurringThemes
//   - highSeverityComplaints
//   - duplicateClusters (complaints with similar subjects)
//   - totals
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(
      200,
      parseInt(url.searchParams.get("limit") || "100", 10)
    );

    const analyzed = await db.complaint.findMany({
      where: { aiAnalyzedAt: { not: null } },
      include: {
        region: true,
        department: true,
        classification: true,
      },
      take: limit,
      orderBy: { aiAnalyzedAt: "desc" },
    });

    if (analyzed.length === 0) {
      return NextResponse.json({
        totals: { analyzed: 0, highSeverity: 0, duplicates: 0 },
        sentimentDistribution: [],
        severityBuckets: [],
        topClassifications: [],
        topKeywords: [],
        recurringThemes: [],
        highSeverityComplaints: [],
        duplicateClusters: [],
      });
    }

    // Sentiment distribution
    const sentimentCounts: Record<string, number> = {};
    for (const c of analyzed) {
      const s = c.aiSentiment || "neutral";
      sentimentCounts[s] = (sentimentCounts[s] || 0) + 1;
    }
    const sentimentLabels: Record<string, string> = {
      positive: "إيجابي",
      neutral: "محايد",
      negative: "سلبي",
      very_negative: "سلبي جداً",
    };
    const sentimentDistribution = Object.entries(sentimentCounts).map(
      ([key, value]) => ({
        name: sentimentLabels[key] || key,
        key,
        value,
      })
    );

    // Severity buckets based on aiSeverityScore
    const severityBuckets = [
      { name: "منخفضة (0-25)", key: "low", min: 0, max: 25, value: 0 },
      { name: "متوسطة (26-50)", key: "medium", min: 26, max: 50, value: 0 },
      { name: "عالية (51-75)", key: "high", min: 51, max: 75, value: 0 },
      { name: "حرجة (76-100)", key: "critical", min: 76, max: 100, value: 0 },
    ];
    for (const c of analyzed) {
      const score = c.aiSeverityScore ?? 0;
      const bucket = severityBuckets.find(
        (b) => score >= b.min && score <= b.max
      );
      if (bucket) bucket.value += 1;
    }

    // Top AI classifications
    const classCounts: Record<string, number> = {};
    for (const c of analyzed) {
      const k = c.aiClassification || "غير مصنف";
      classCounts[k] = (classCounts[k] || 0) + 1;
    }
    const topClassifications = Object.entries(classCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // Top keywords (extract from subject + summary). Simple tokenizer that
    // strips Arabic diacritics and common stopwords.
    const STOPWORDS = new Set([
      "في", "من", "على", "إلى", "عن", "مع", "أن", "إن", "كان", "لم", "لن",
      "قد", "هذا", "هذه", "ذلك", "التي", "الذي", "عند", "بعد", "قبل", "أو",
      "و", "ثم", "حيث", "كل", "بعض", "تم", "إلى", "لدى", "دون", "أكثر",
      "أقل", "كما", "حول", "نحو", "بين", "ضمن", "خلال", "عبر", "غير", "إلى",
      "لأن", "لكن", "حتى", "إذا", "عندما", "كذلك", "ايضا", "أيضا", "ال",
    ]);

    function tokenize(text: string): string[] {
      if (!text) return [];
      const cleaned = text
        .replace(/[\u064B-\u065F\u0670]/g, "") // remove diacritics
        .replace(/[^\u0600-\u06FF\s]/g, " ") // keep Arabic letters
        .trim();
      if (!cleaned) return [];
      return cleaned
        .split(/\s+/)
        .map((t) => t.replace(/^ال+/, "")) // strip leading "ال"
        .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
    }

    const keywordCounts: Record<string, number> = {};
    for (const c of analyzed) {
      const tokens = [
        ...tokenize(c.subject || ""),
        ...tokenize(c.aiSummary || ""),
      ];
      for (const t of tokens) {
        keywordCounts[t] = (keywordCounts[t] || 0) + 1;
      }
    }
    const topKeywords = Object.entries(keywordCounts)
      .map(([word, count]) => ({ word, count }))
      .filter((k) => k.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // Recurring themes: group by aiClassification with high severity
    const recurringThemes = topClassifications.slice(0, 5).map((t) => {
      const matching = analyzed.filter(
        (c) => (c.aiClassification || "غير مصنف") === t.name
      );
      const avgSeverity =
        matching.reduce((sum, c) => sum + (c.aiSeverityScore ?? 0), 0) /
        matching.length;
      return {
        name: t.name,
        count: t.count,
        avgSeverity: Math.round(avgSeverity),
      };
    });

    // High severity complaints (score >= 70)
    const highSeverityComplaints = analyzed
      .filter((c) => (c.aiSeverityScore ?? 0) >= 70)
      .map((c) => ({
        id: c.id,
        complaintNumber: c.complaintNumber,
        subject: c.subject,
        aiClassification: c.aiClassification,
        aiSeverityScore: c.aiSeverityScore,
        aiSentiment: c.aiSentiment,
        region: c.region?.name,
      }))
      .sort((a, b) => (b.aiSeverityScore ?? 0) - (a.aiSeverityScore ?? 0))
      .slice(0, 10);

    // Duplicate clusters: complaints with similar subjects (normalized exact
    // match on first 40 chars of subject after diacritics removal).
    function normalizeSubject(s: string): string {
      if (!s) return "";
      return s
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/[^\u0600-\u06FF\s]/g, " ")
        .trim()
        .slice(0, 40);
    }

    const subjectGroups: Record<string, typeof analyzed> = {};
    for (const c of analyzed) {
      const key = normalizeSubject(c.subject || "");
      if (!key) continue;
      if (!subjectGroups[key]) subjectGroups[key] = [];
      subjectGroups[key].push(c);
    }
    const duplicateClusters = Object.entries(subjectGroups)
      .filter(([, group]) => group.length >= 2)
      .map(([key, group]) => ({
        key,
        count: group.length,
        complaints: group.map((c) => ({
          id: c.id,
          complaintNumber: c.complaintNumber,
          subject: c.subject,
          aiClassification: c.aiClassification,
        })),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    return NextResponse.json({
      totals: {
        analyzed: analyzed.length,
        highSeverity: highSeverityComplaints.length,
        duplicates: duplicateClusters.length,
      },
      sentimentDistribution,
      severityBuckets,
      topClassifications,
      topKeywords,
      recurringThemes,
      highSeverityComplaints,
      duplicateClusters,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "خطأ غير معروف";
    console.error("AI insights route error:", msg);
    return NextResponse.json(
      { error: `فشل تجميع الرؤى: ${msg}` },
      { status: 500 }
    );
  }
}
