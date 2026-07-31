"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Sparkles, Brain, AlertTriangle, FileText, Loader2, RefreshCw,
  ShieldAlert, CheckCircle2, XCircle, ThumbsUp, ThumbsDown, Trash2,
} from "lucide-react";
import { formatDate, formatDateTime } from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AiStatus {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  maxInputComplaints: number;
  dailyRunLimit: number;
  retentionDays: number;
}

interface AnalysisRun {
  id: string;
  analysisType: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  model: string | null;
  provider: string | null;
  promptVersion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
  createdAt: string;
  expiresAt: string | null;
  hasResult: boolean;
  feedbackCount: number;
  inputSummary: { totalMatching: number; sentToAi: number; truncated: boolean } | null;
}

interface AnalysisDetail extends AnalysisRun {
  filtersSnapshot: Record<string, string | undefined>;
  result: Record<string, unknown> | null;
  feedbacks: { id: string; rating: string; comment?: string; createdAt: string }[];
}

// ─── Analysis type labels ─────────────────────────────────────────────────────

const ANALYSIS_TYPES: { value: string; label: string; description: string }[] = [
  { value: "EXECUTIVE_SUMMARY", label: "الملخص التنفيذي", description: "نظرة عامة على أبرز المؤشرات والتغيرات" },
  { value: "RECURRING_TOPICS", label: "الموضوعات المتكررة", description: "اكتشاف الأنماط والموضوعات الشائعة" },
  { value: "POSSIBLE_ROOT_CAUSES", label: "الأسباب الجذرية المحتملة", description: "تحليل احتمالي للمسببات" },
  { value: "ANOMALY_ANALYSIS", label: "تحليل الانحرافات", description: "اكتشاف الارتفاعات والانخرافات غير المعتادة" },
  { value: "IMPROVEMENT_OPPORTUNITIES", label: "فرص التطوير", description: "اقتراحات قابلة للتنفيذ" },
];

const TYPE_LABELS: Record<string, string> = Object.fromEntries(ANALYSIS_TYPES.map(t => [t.value, t.label]));

const STATUS_CONFIG = {
  PENDING: { label: "قيد الانتظار", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  RUNNING: { label: "قيد التنفيذ", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
  COMPLETED: { label: "مكتمل", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" },
  FAILED: { label: "فشل", color: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" },
};

// ─── Main Component ───────────────────────────────────────────────────────────

export function AiAnalysis() {
  const { toast } = useToast();

  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [selectedDetail, setSelectedDetail] = useState<AnalysisDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [selectedType, setSelectedType] = useState("EXECUTIVE_SUMMARY");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [running, setRunning] = useState(false);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    setLoadingStatus(true);
    try {
      const res = await fetch("/api/ai/status", { signal });
      if (!res.ok) throw new Error("Failed to load AI status");
      const json = await res.json() as AiStatus;
      if (!signal?.aborted) setAiStatus(json);
    } catch (err) {
      if (isAbortError(err)) return;
      toast({ variant: "destructive", title: "خطأ", description: "تعذر تحميل حالة الذكاء الاصطناعي" });
    } finally {
      if (!signal?.aborted) setLoadingStatus(false);
    }
  }, [toast]);

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    setLoadingRuns(true);
    try {
      const res = await fetch("/api/ai/analyses?pageSize=20", { signal });
      if (!res.ok) throw new Error("Failed");
      const json = await res.json() as { items: AnalysisRun[] };
      if (!signal?.aborted) setRuns(json.items ?? []);
    } catch (err) {
      if (isAbortError(err)) return;
    } finally {
      if (!signal?.aborted) setLoadingRuns(false);
    }
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void Promise.resolve().then(() => {
      if (!c.signal.aborted) {
        void Promise.all([loadStatus(c.signal), loadRuns(c.signal)]);
      }
    });
    return () => c.abort();
  }, [loadStatus, loadRuns]);

  const loadDetail = async (id: string) => {
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/ai/analyses/${id}`);
      if (!res.ok) { toast({ variant: "destructive", title: "خطأ", description: "تعذر تحميل التفاصيل" }); return; }
      const json = await res.json() as AnalysisDetail;
      setSelectedDetail(json);
    } finally {
      setLoadingDetail(false);
    }
  };

  const runAnalysis = async () => {
    if (!aiStatus?.enabled) return;
    setRunning(true);
    try {
      const filters: Record<string, string> = {};
      if (dateFrom) filters.dateFrom = dateFrom;
      if (dateTo) filters.dateTo = dateTo;

      const res = await fetch("/api/ai/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisType: selectedType, filters }),
      });
      const json = await res.json() as { runId?: string; error?: string; message?: string };
      if (!res.ok) {
        const msg = json.message ?? json.error ?? "فشل التحليل";
        if (res.status === 409) throw new Error("تحليل آخر قيد التنفيذ — انتظر اكتماله");
        if (res.status === 429) throw new Error(`تجاوز الحد اليومي: ${msg}`);
        throw new Error(msg);
      }
      toast({ title: "اكتمل التحليل", description: "النتيجة متاحة في السجل أدناه" });
      await loadRuns();
      if (json.runId) await loadDetail(json.runId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "خطأ غير معروف";
      toast({ variant: "destructive", title: "فشل التحليل", description: msg });
    } finally {
      setRunning(false);
    }
  };

  const sendFeedback = async (runId: string, rating: "helpful" | "not_helpful") => {
    try {
      await fetch(`/api/ai/analyses/${runId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
      toast({ title: "شكراً على تقييمك" });
      if (selectedDetail?.id === runId) {
        await loadDetail(runId);
      }
    } catch {
      toast({ variant: "destructive", title: "خطأ", description: "تعذر حفظ التقييم" });
    }
  };

  const deleteResult = async (runId: string) => {
    try {
      await fetch(`/api/ai/analyses/${runId}`, { method: "DELETE" });
      toast({ title: "حُذفت النتيجة" });
      setSelectedDetail(null);
      await loadRuns();
    } catch {
      toast({ variant: "destructive", title: "خطأ", description: "تعذر الحذف" });
    }
  };

  function renderAiStatusSection() {
    if (loadingStatus) {
      return <Skeleton className="h-16 w-full" />;
    }
    if (aiStatus && !aiStatus.enabled) {
      return (
        <Card className="border-slate-200 dark:border-slate-700">
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <XCircle className="h-10 w-10 text-slate-400 mb-3" />
            <p className="font-semibold text-lg">الذكاء الاصطناعي غير مفعّل</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              لتفعيل الذكاء الاصطناعي، اضبط <code className="bg-muted px-1 rounded">AI_ENABLED=true</code> في ملف
              البيئة مع مفتاح API صالح. يمكن تعطيله في أي وقت.
            </p>
          </CardContent>
        </Card>
      );
    }
    return renderActiveAiContent();
  }

  function renderDetailContent(detail: AnalysisDetail) {
    if (detail.status === "FAILED") {
      return (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>فشل التحليل</AlertTitle>
          <AlertDescription>رمز الخطأ: {detail.errorCode ?? "UNKNOWN"}</AlertDescription>
        </Alert>
      );
    }
    if (detail.result) {
      return <StructuredResultView result={detail.result} type={detail.analysisType} />;
    }
    return <p className="text-sm text-muted-foreground text-center py-6">لا توجد نتيجة</p>;
  }

  function renderRunsList() {
    if (loadingRuns) {
      return (
        <div className="space-y-2">
          {[1, 2, 3].map(n => <Skeleton key={n} className="h-14 w-full" />)}
        </div>
      );
    }
    if (runs.length === 0) {
      return (
        <div className="flex flex-col items-center py-10 text-center">
          <Brain className="h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-sm">لا توجد تحليلات سابقة</p>
        </div>
      );
    }
    return (
      <ScrollArea className="h-[320px]">
        <div className="space-y-2">
          {runs.map(r => {
            const sc = STATUS_CONFIG[r.status] ?? STATUS_CONFIG.FAILED;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => { if (r.hasResult || r.status === "FAILED") void loadDetail(r.id); }}
                className="w-full text-right flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{TYPE_LABELS[r.analysisType] ?? r.analysisType}</span>
                    <Badge className={`text-xs ${sc.color}`}>{sc.label}</Badge>
                    {r.feedbackCount > 0 && (
                      <Badge variant="outline" className="text-xs">
                        <CheckCircle2 className="h-3 w-3 mr-0.5" />
                        {r.feedbackCount} تقييم
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDate(r.createdAt)}
                    {r.inputSummary?.totalMatching !== undefined && (
                      <> | {r.inputSummary.totalMatching} شكوى</>
                    )}
                    {r.expiresAt && <> | ينتهي {formatDate(r.expiresAt)}</>}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    );
  }

  function renderActiveAiContent() {
    return (
      <>
        {/* Run Analysis Form */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Brain className="h-4 w-4 text-primary" />
              تشغيل تحليل جديد
            </CardTitle>
            <CardDescription className="text-xs">
              المزود: {aiStatus?.provider} | النموذج: {aiStatus?.model}
              {" "} | الحد اليومي: {aiStatus?.dailyRunLimit} تحليل
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="analysis-type" className="text-sm font-medium">نوع التحليل</Label>
                <Select value={selectedType} onValueChange={setSelectedType} disabled={running}>
                  <SelectTrigger id="analysis-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ANALYSIS_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>
                        <div>
                          <div className="font-medium">{t.label}</div>
                          <div className="text-xs text-muted-foreground">{t.description}</div>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="date-from" className="text-sm font-medium">من تاريخ (اختياري)</Label>
                <input
                  id="date-from"
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  disabled={running}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="date-to" className="text-sm font-medium">إلى تاريخ (اختياري)</Label>
                <input
                  id="date-to"
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  disabled={running}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                />
              </div>
            </div>

            <Alert className="py-2">
              <AlertDescription className="text-xs">
                <strong>قبل التشغيل:</strong> يتحقق النظام من البيانات المؤهلة. لا تُرسل بيانات شخصية.
                تحليل واحد فقط في نفس الوقت. النتائج محفوظة {aiStatus?.retentionDays} يوماً.
              </AlertDescription>
            </Alert>

            <Button
              type="button"
              onClick={() => void runAnalysis()}
              disabled={running}
              className="w-full md:w-auto"
            >
              {running ? (
                <><Loader2 className="h-4 w-4 animate-spin" />جاري التحليل...</>
              ) : (
                <><Sparkles className="h-4 w-4" />تشغيل التحليل</>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Result Display */}
        {selectedDetail && (
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    {TYPE_LABELS[selectedDetail.analysisType] ?? selectedDetail.analysisType}
                  </CardTitle>
                  <CardDescription className="text-xs mt-1">
                    {formatDateTime(selectedDetail.completedAt ?? selectedDetail.createdAt)}
                    {" "} | نموذج: {selectedDetail.model ?? "—"}
                    {" "} | إصدار Prompt: {selectedDetail.promptVersion ?? "—"}
                    {selectedDetail.inputSummary && (
                      <> | شكاوى: {selectedDetail.inputSummary.sentToAi}
                        {selectedDetail.inputSummary.truncated && " (مختصرة)"}
                      </>
                    )}
                  </CardDescription>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void sendFeedback(selectedDetail.id, "helpful")}
                  >
                    <ThumbsUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void sendFeedback(selectedDetail.id, "not_helpful")}
                  >
                    <ThumbsDown className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void deleteResult(selectedDetail.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {renderDetailContent(selectedDetail)}

              {/* Limitations */}
              {selectedDetail.result && ((selectedDetail.result as { limitations?: string[] }).limitations?.length ?? 0) > 0 && (
                <div className="mt-4 p-3 rounded-lg bg-muted/40 border border-border">
                  <p className="text-xs font-semibold mb-1 flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    قيود هذا التحليل:
                  </p>
                  <ul className="text-xs text-muted-foreground space-y-1">
                    {(selectedDetail.result as { limitations: string[] }).limitations.map(l => (
                      <li key={l.slice(0, 64)}>• {l}</li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="text-xs text-muted-foreground mt-3 text-center">
                هذا تحليل مساعد. القرار النهائي للمختص البشري.
              </p>
            </CardContent>
          </Card>
        )}

        {/* History */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-primary" />
              سجل التحليلات
            </CardTitle>
          </CardHeader>
          <CardContent>
            {renderRunsList()}
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="التحليل الذكي للشكاوى"
        description="تحليل مساعد محكوم — القرار النهائي للمختص البشري دائماً"
        icon={<Sparkles className="h-6 w-6" />}
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => { void loadStatus(); void loadRuns(); }}>
            <RefreshCw className="h-4 w-4" />
            تحديث
          </Button>
        }
      />

      {/* Governance banner */}
      <Alert className="border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700">
        <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
        <AlertTitle className="text-amber-900 dark:text-amber-200 font-bold">
          تنبيه: التحليل الذكي مساعد وليس صاحب قرار
        </AlertTitle>
        <AlertDescription className="text-amber-800 dark:text-amber-300">
          جميع نتائج الذكاء الاصطناعي مساعدة ولا تُعدّل البيانات ولا تتخذ قرارات آلية.
          يجب مراجعة كل نتيجة بشرياً قبل اتخاذ أي إجراء. البيانات الشخصية لا تُرسل للذكاء الاصطناعي.
        </AlertDescription>
      </Alert>

      {renderAiStatusSection()}

      {loadingDetail && (
        <div className="fixed inset-0 bg-background/50 flex items-center justify-center z-50">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      )}
    </div>
  );
}

// ─── Structured Result Renderer ────────────────────────────────────────────────
// Renders JSON result as structured sections. No dangerouslySetInnerHTML.

function StructuredResultView({ result, type }: Readonly<{ result: Record<string, unknown>; type: string }>) {
  const summary = typeof result.summary === "string" ? result.summary : null;

  return (
    <div className="space-y-4">
      {summary && (
        <div className="rounded-lg bg-primary/5 p-4 border border-primary/20">
          <p className="text-xs font-semibold mb-1 text-primary">الملخص</p>
          <p className="text-sm leading-relaxed">{summary}</p>
        </div>
      )}

      {type === "EXECUTIVE_SUMMARY" && (
        <ExecutiveSummaryView result={result as Record<string, unknown[]>} />
      )}
      {type === "RECURRING_TOPICS" && (
        <RecurringTopicsView result={result as { topics: unknown[] }} />
      )}
      {type === "POSSIBLE_ROOT_CAUSES" && (
        <RootCausesView result={result as { causes: unknown[] }} />
      )}
      {type === "ANOMALY_ANALYSIS" && (
        <AnomalyView result={result as { anomalies: unknown[]; overallAssistantNote?: string }} />
      )}
      {type === "IMPROVEMENT_OPPORTUNITIES" && (
        <ImprovementsView result={result as { opportunities: unknown[] }} />
      )}
    </div>
  );
}

function Section({ title, items, icon }: Readonly<{ title: string; items: string[]; icon?: React.ReactNode }>) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="text-xs font-semibold mb-2 flex items-center gap-1">{icon}{title}</p>
      <ul className="space-y-1.5">
        {items.map(item => (
          <li
            key={typeof item === "string" ? item.slice(0, 64) : String(item)}
            className="text-sm text-muted-foreground bg-muted/30 rounded-md px-3 py-2"
          >
            {String(item)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExecutiveSummaryView({ result }: Readonly<{ result: Record<string, unknown[]> }>) {
  return (
    <div className="space-y-4">
      <Section title="أبرز النتائج" items={(result.highlights as string[]) ?? []} />
      <Section title="مناطق المخاطر" items={((result.riskAreas as { title: string; detail: string }[]) ?? []).map(r => `${r.title}: ${r.detail}`)} />
      <Section title="فرص التحسين" items={(result.improvementOpportunities as string[]) ?? []} />
      <Section title="أسئلة تحتاج مراجعة بشرية" items={(result.questionsForReview as string[]) ?? []} />
    </div>
  );
}

function RecurringTopicsView({ result }: Readonly<{ result: { topics: unknown[] } }>) {
  const topics = (result.topics ?? []) as {
    label: string; description: string; estimatedCount: number;
    relatedDepartments: string[]; exampleTexts: string[]; confidenceNote: string;
  }[];
  return (
    <div className="space-y-3">
      {topics.map(t => (
        <div key={t.label.slice(0, 64)} className="p-3 rounded-lg border border-border">
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-sm">{t.label}</span>
            <Badge variant="secondary">~{t.estimatedCount} شكوى</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t.description}</p>
          {t.relatedDepartments?.length > 0 && (
            <p className="text-xs mt-1">الإدارات: {t.relatedDepartments.join(", ")}</p>
          )}
          <p className="text-xs text-muted-foreground mt-1 italic">ثقة: {t.confidenceNote}</p>
        </div>
      ))}
    </div>
  );
}

function RootCausesView({ result }: Readonly<{ result: { causes: unknown[] } }>) {
  const causes = (result.causes ?? []) as {
    possibleCause: string; supportingIndicators: string[];
    counterIndicators: string[]; probabilityNote: string;
  }[];
  return (
    <div className="space-y-3">
      {causes.map(c => (
        <div key={c.possibleCause.slice(0, 64)} className="p-3 rounded-lg border border-border">
          <p className="font-medium text-sm mb-1">{c.possibleCause}</p>
          {c.supportingIndicators?.length > 0 && (
            <div>
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">مؤشرات داعمة:</p>
              <ul className="text-xs text-muted-foreground">
                {c.supportingIndicators.map(s => <li key={s.slice(0, 64)}>• {s}</li>)}
              </ul>
            </div>
          )}
          {c.counterIndicators?.length > 0 && (
            <div className="mt-1">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-300">مؤشرات معارضة:</p>
              <ul className="text-xs text-muted-foreground">
                {c.counterIndicators.map(s => <li key={s.slice(0, 64)}>• {s}</li>)}
              </ul>
            </div>
          )}
          <p className="text-xs italic text-muted-foreground mt-1">{c.probabilityNote}</p>
        </div>
      ))}
    </div>
  );
}

function AnomalyView({ result }: Readonly<{ result: { anomalies: unknown[]; overallAssistantNote?: string } }>) {
  const anomalies = (result.anomalies ?? []) as {
    affectedArea: string; observedPattern: string; magnitude: string;
    possibleExplanations: string[]; assistantNote: string;
  }[];
  return (
    <div className="space-y-3">
      {result.overallAssistantNote && (
        <Alert><AlertDescription className="text-xs">{result.overallAssistantNote}</AlertDescription></Alert>
      )}
      {anomalies.map(a => (
        <div
          key={a.affectedArea.slice(0, 64)}
          className="p-3 rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/10"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-sm">{a.affectedArea}</span>
            <Badge variant="outline">{a.magnitude}</Badge>
          </div>
          <p className="text-xs">{a.observedPattern}</p>
          {a.possibleExplanations?.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">تفسيرات محتملة: {a.possibleExplanations.join(" | ")}</p>
          )}
          <p className="text-xs italic text-muted-foreground mt-1">{a.assistantNote}</p>
        </div>
      ))}
    </div>
  );
}

function ImprovementsView({ result }: Readonly<{ result: { opportunities: unknown[] } }>) {
  const opps = (result.opportunities ?? []) as {
    opportunity: string; relatedProblem: string; suggestedPriority: string;
    expectedImpact: string; suggestedAction: string; followUpMetric: string;
  }[];
  const priorityColors: Record<string, string> = {
    HIGH: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
    MEDIUM: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    LOW: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  };
  return (
    <div className="space-y-3">
      {opps.map(o => (
        <div key={o.opportunity.slice(0, 64)} className="p-3 rounded-lg border border-border">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-sm flex-1">{o.opportunity}</span>
            <Badge className={`text-xs ${priorityColors[o.suggestedPriority] ?? ""}`}>{o.suggestedPriority}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{o.relatedProblem}</p>
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="text-xs"><span className="font-medium">الإجراء:</span> {o.suggestedAction}</div>
            <div className="text-xs"><span className="font-medium">الأثر:</span> {o.expectedImpact}</div>
            <div className="text-xs"><span className="font-medium">مقياس المتابعة:</span> {o.followUpMetric}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
