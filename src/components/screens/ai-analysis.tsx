"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import {
  Sparkles,
  Brain,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Tag,
  Heart,
  Gauge,
  Loader2,
  RefreshCw,
  ListChecks,
  ShieldAlert,
  Layers,
  Copy,
  XCircle,
  Pencil,
} from "lucide-react";
import {
  formatNumber,
  formatPercent,
  formatDate,
  formatDateTime,
  STATUS_LABELS,
  statusBadgeClass,
} from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";

// ---------- Types ----------
interface ComplaintRelation {
  id: string;
  name: string;
}

interface Complaint {
  id: string;
  complaintNumber: string;
  receivedDate: string;
  channel: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  severity: string;
  region?: ComplaintRelation | null;
  location?: ComplaintRelation | null;
  department?: ComplaintRelation | null;
  classification?: ComplaintRelation | null;
  // AI fields
  aiClassification?: string | null;
  aiConfidence?: number | null;
  aiReasoning?: string | null;
  aiSentiment?: string | null;
  aiSeverityScore?: number | null;
  aiSummary?: string | null;
  aiAnalyzedAt?: string | null;
  isPotentialDuplicate?: boolean;
}

interface InsightsData {
  totals: {
    analyzed: number;
    highSeverity: number;
    duplicates: number;
  };
  sentimentDistribution: { name: string; key: string; value: number }[];
  severityBuckets: { name: string; key: string; value: number }[];
  topClassifications: { name: string; count: number }[];
  topKeywords: { word: string; count: number }[];
  recurringThemes: {
    name: string;
    count: number;
    avgSeverity: number;
  }[];
  highSeverityComplaints: {
    id: string;
    complaintNumber: string;
    subject: string;
    aiClassification?: string | null;
    aiSeverityScore?: number | null;
    aiSentiment?: string | null;
    region?: string | null;
  }[];
  duplicateClusters: {
    key: string;
    count: number;
    complaints: {
      id: string;
      complaintNumber: string;
      subject: string;
      aiClassification?: string | null;
    }[];
  }[];
}

// ---------- Helpers ----------
const SENTIMENT_META: Record<
  string,
  { label: string; color: string; bg: string; text: string }
> = {
  positive: {
    label: "إيجابي",
    color: "#16a34a",
    bg: "bg-emerald-100 dark:bg-emerald-900/30",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  neutral: {
    label: "محايد",
    color: "#64748b",
    bg: "bg-slate-100 dark:bg-slate-800/60",
    text: "text-slate-700 dark:text-slate-300",
  },
  negative: {
    label: "سلبي",
    color: "#f59e0b",
    bg: "bg-amber-100 dark:bg-amber-900/30",
    text: "text-amber-700 dark:text-amber-300",
  },
  very_negative: {
    label: "سلبي جداً",
    color: "#ef4444",
    bg: "bg-rose-100 dark:bg-rose-900/30",
    text: "text-rose-700 dark:text-rose-300",
  },
};

function sentimentMeta(s?: string | null) {
  return SENTIMENT_META[s || "neutral"] || SENTIMENT_META.neutral;
}

function confidenceColor(conf: number): string {
  if (conf >= 0.7) return "#16a34a"; // green
  if (conf >= 0.4) return "#f59e0b"; // amber
  return "#ef4444"; // red
}

function confidenceBarClass(conf: number): string {
  if (conf >= 0.7) return "[&>[data-slot=progress-indicator]]:bg-emerald-500";
  if (conf >= 0.4) return "[&>[data-slot=progress-indicator]]:bg-amber-500";
  return "[&>[data-slot=progress-indicator]]:bg-rose-500";
}

function severityMeta(score: number): {
  label: string;
  color: string;
  bg: string;
  text: string;
} {
  if (score >= 76)
    return {
      label: "حرجة",
      color: "#dc2626",
      bg: "bg-rose-100 dark:bg-rose-900/30",
      text: "text-rose-700 dark:text-rose-300",
    };
  if (score >= 51)
    return {
      label: "عالية",
      color: "#f97316",
      bg: "bg-orange-100 dark:bg-orange-900/30",
      text: "text-orange-700 dark:text-orange-300",
    };
  if (score >= 26)
    return {
      label: "متوسطة",
      color: "#f59e0b",
      bg: "bg-amber-100 dark:bg-amber-900/30",
      text: "text-amber-700 dark:text-amber-300",
    };
  return {
    label: "منخفضة",
    color: "#16a34a",
    bg: "bg-emerald-100 dark:bg-emerald-900/30",
    text: "text-emerald-700 dark:text-emerald-300",
  };
}

const SEVERITY_GAUGE_COLORS = ["#16a34a", "#f59e0b", "#f97316", "#dc2626"];
const SENTIMENT_PIE_COLORS: Record<string, string> = {
  positive: "#16a34a",
  neutral: "#64748b",
  negative: "#f59e0b",
  very_negative: "#ef4444",
};

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

// ---------- Main Component ----------
export function AiAnalysis() {
  const { toast } = useToast();
  const [loadingUnanalyzed, setLoadingUnanalyzed] = useState(true);
  const [loadingAnalyzed, setLoadingAnalyzed] = useState(true);
  const [loadingInsights, setLoadingInsights] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);

  const [unanalyzed, setUnanalyzed] = useState<Complaint[]>([]);
  const [analyzed, setAnalyzed] = useState<Complaint[]>([]);
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [executiveSummary, setExecutiveSummary] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"analyze" | "insights">("analyze");

  // Modify dialog state
  const [modifyTarget, setModifyTarget] = useState<Complaint | null>(null);
  const [modifyClassification, setModifyClassification] = useState<string>("");
  const [modifySeverity, setModifySeverity] = useState<string>("");
  const [modifyPriority, setModifyPriority] = useState<string>("");
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const unanalyzedRequestRef = useRef(0);
  const analyzedRequestRef = useRef(0);
  const insightsRequestRef = useRef(0);

  const loadUnanalyzed = useCallback(async (signal?: AbortSignal) => {
    const requestId = unanalyzedRequestRef.current + 1;
    unanalyzedRequestRef.current = requestId;
    const canUpdate = () => !signal?.aborted && unanalyzedRequestRef.current === requestId;
    setLoadingUnanalyzed(true);
    let aborted = false;
    try {
      const res = await fetch(
        "/api/complaints?aiAnalyzed=false&pageSize=50&sortBy=receivedDate&sortOrder=desc",
        { signal }
      );
      const json = await res.json();
      if (canUpdate()) {
        setUnanalyzed(json?.data ?? []);
      }
    } catch (err) {
      aborted = isAbortError(err);
      if (aborted) {
        return;
      }
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "تعذّر تحميل الشكاوى غير المحللة",
      });
    } finally {
      if (!aborted && canUpdate()) {
        setLoadingUnanalyzed(false);
      }
    }
  }, [toast]);

  const loadAnalyzed = useCallback(async (signal?: AbortSignal) => {
    const requestId = analyzedRequestRef.current + 1;
    analyzedRequestRef.current = requestId;
    const canUpdate = () => !signal?.aborted && analyzedRequestRef.current === requestId;
    setLoadingAnalyzed(true);
    let aborted = false;
    try {
      const res = await fetch(
        "/api/complaints?aiAnalyzed=true&pageSize=50&sortBy=receivedDate&sortOrder=desc",
        { signal }
      );
      const json = await res.json();
      if (canUpdate()) {
        setAnalyzed(json?.data ?? []);
      }
    } catch (err) {
      aborted = isAbortError(err);
      if (aborted) {
        return;
      }
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "تعذّر تحميل الشكاوى المحللة",
      });
    } finally {
      if (!aborted && canUpdate()) {
        setLoadingAnalyzed(false);
      }
    }
  }, [toast]);

  const loadInsights = useCallback(async (signal?: AbortSignal) => {
    const requestId = insightsRequestRef.current + 1;
    insightsRequestRef.current = requestId;
    const canUpdate = () => !signal?.aborted && insightsRequestRef.current === requestId;
    setLoadingInsights(true);
    let aborted = false;
    try {
      const res = await fetch("/api/ai/insights?limit=200", { signal });
      const json = await res.json();
      if (canUpdate()) {
        setInsights(json);
      }
    } catch (err) {
      aborted = isAbortError(err);
      if (aborted) {
        return;
      }
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "تعذّر تحميل الرؤى المجمعة",
      });
    } finally {
      if (!aborted && canUpdate()) {
        setLoadingInsights(false);
      }
    }
  }, [toast]);

  const loadAll = useCallback((signal?: AbortSignal) => {
    void loadUnanalyzed(signal);
    void loadAnalyzed(signal);
    void loadInsights(signal);
  }, [loadUnanalyzed, loadAnalyzed, loadInsights]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        loadAll(controller.signal);
      }
    });
    return () => {
      controller.abort();
    };
  }, [loadAll]);

  // Auto-switch to insights tab when analyzed complaints exist
  // (user can still switch back manually)
  const analyzedCount = analyzed.length;

  // ---------- Handlers ----------
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(unanalyzed.map((c) => c.id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const runAnalysis = async () => {
    if (selectedIds.size === 0) {
      toast({
        variant: "destructive",
        title: "تنبيه",
        description: "اختر شكوى واحدة على الأقل للتحليل",
      });
      return;
    }
    setAnalyzing(true);
    try {
      const res = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ complaintIds: Array.from(selectedIds) }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "فشل التحليل");
      }
      toast({
        title: "اكتمل التحليل",
        description: json.message || `تم تحليل ${json.analyzed} شكوى`,
      });
      setSelectedIds(new Set());
      // Reload lists
      loadUnanalyzed();
      loadAnalyzed();
      loadInsights();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "خطأ غير معروف";
      toast({
        variant: "destructive",
        title: "فشل التحليل",
        description: msg,
      });
    } finally {
      setAnalyzing(false);
    }
  };

  const reanalyzeOne = async (complaintId: string) => {
    setAnalyzing(true);
    try {
      const res = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ complaintId }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "فشل التحليل");
      }
      toast({
        title: "تمت إعادة التحليل",
        description: `تم تحديث تحليل الشكوى`,
      });
      loadAnalyzed();
      loadInsights();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "خطأ غير معروف";
      toast({
        variant: "destructive",
        title: "فشل التحليل",
        description: msg,
      });
    } finally {
      setAnalyzing(false);
    }
  };

  const approve = async (complaintId: string) => {
    setApprovingId(complaintId);
    try {
      const res = await fetch("/api/ai/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          complaintId,
          action: "approve",
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "فشل الاعتماد");
      }
      toast({
        title: "تم الاعتماد",
        description: json.message || "تم اعتماد اقتراح الذكاء الاصطناعي",
      });
      loadAnalyzed();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "خطأ غير معروف";
      toast({
        variant: "destructive",
        title: "فشل الاعتماد",
        description: msg,
      });
    } finally {
      setApprovingId(null);
    }
  };

  const dismiss = async (complaintId: string) => {
    setApprovingId(complaintId);
    try {
      const res = await fetch("/api/ai/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ complaintId, action: "dismiss" }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "فشل الإجراء");
      }
      toast({
        title: "تم التجاهل",
        description: "تم تجاهل اقتراح الذكاء الاصطناعي",
      });
      loadAnalyzed();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "خطأ غير معروف";
      toast({
        variant: "destructive",
        title: "فشل الإجراء",
        description: msg,
      });
    } finally {
      setApprovingId(null);
    }
  };

  const openModify = (c: Complaint) => {
    setModifyTarget(c);
    setModifyClassification(c.aiClassification || "");
    setModifySeverity("");
    setModifyPriority("");
  };

  const submitModify = async () => {
    if (!modifyTarget) return;
    setApprovingId(modifyTarget.id);
    try {
      const res = await fetch("/api/ai/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          complaintId: modifyTarget.id,
          action: "modify",
          modifiedClassification: modifyClassification || undefined,
          modifiedSeverity: modifySeverity || undefined,
          modifiedPriority: modifyPriority || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "فشل التعديل");
      }
      toast({
        title: "تم التعديل",
        description: json.message || "تم تطبيق التعديلات اليدوية",
      });
      setModifyTarget(null);
      loadAnalyzed();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "خطأ غير معروف";
      toast({
        variant: "destructive",
        title: "فشل التعديل",
        description: msg,
      });
    } finally {
      setApprovingId(null);
    }
  };

  const generateSummary = async () => {
    setGeneratingSummary(true);
    try {
      const res = await fetch("/api/ai/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "فشل توليد الملخص");
      }
      setExecutiveSummary(json.summary);
      toast({
        title: "تم توليد الملخص",
        description: `ملخص لـ ${formatNumber(json.count)} شكوى محللة`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "خطأ غير معروف";
      toast({
        variant: "destructive",
        title: "فشل توليد الملخص",
        description: msg,
      });
    } finally {
      setGeneratingSummary(false);
    }
  };

  // Derived stats
  const stats = useMemo(() => {
    const total = analyzed.length;
    const high = analyzed.filter(
      (c) => (c.aiSeverityScore ?? 0) >= 70
    ).length;
    const avgConf =
      total === 0
        ? 0
        : analyzed.reduce((s, c) => s + (c.aiConfidence ?? 0), 0) / total;
    const negative =
      analyzed.filter(
        (c) => c.aiSentiment === "negative" || c.aiSentiment === "very_negative"
      ).length;
    return { total, high, avgConf, negative };
  }, [analyzed]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="التحليل الذكي للشكاوى"
        description="تحليل آلي مساعد لنصوص الشكاوى باستخدام الذكاء الاصطناعي"
        icon={<Sparkles className="h-6 w-6" />}
        actions={
          <Button variant="outline" size="sm" onClick={() => loadAll()}>
            <RefreshCw className="h-4 w-4" />
            تحديث
          </Button>
        }
      />

      {/* Safety banner */}
      <Alert className="border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700">
        <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
        <AlertTitle className="text-amber-900 dark:text-amber-200 font-bold">
          تنبيه مهم: الذكاء الاصطناعي مساعد وليس صاحب قرار
        </AlertTitle>
        <AlertDescription className="text-amber-800 dark:text-amber-300">
          لا يتم تغيير حالة الشكوى أو تصنيفها نهائياً بقرار آلي. جميع الاقتراحات
          المقدمة بحاجة لمراجعة واعتماد من المسؤول المختص قبل تطبيقها.
        </AlertDescription>
      </Alert>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="شكاوى محللة"
          value={formatNumber(stats.total)}
          icon={<Brain className="h-5 w-5" />}
          color="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300"
          loading={loadingAnalyzed}
        />
        <StatCard
          title="شكاوى ذات خطورة عالية"
          value={formatNumber(stats.high)}
          icon={<AlertTriangle className="h-5 w-5" />}
          color="bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-300"
          loading={loadingAnalyzed}
        />
        <StatCard
          title="متوسط درجة الثقة"
          value={formatPercent(stats.avgConf * 100)}
          icon={<Gauge className="h-5 w-5" />}
          color="bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300"
          loading={loadingAnalyzed}
        />
        <StatCard
          title="مشاعر سلبية"
          value={formatNumber(stats.negative)}
          icon={<Heart className="h-5 w-5" />}
          color="bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300"
          loading={loadingAnalyzed}
        />
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "analyze" | "insights")}
      >
        <TabsList className="w-full md:w-auto">
          <TabsTrigger value="analyze" className="gap-2">
            <ListChecks className="h-4 w-4" />
            تحليل الشكاوى
            {analyzedCount > 0 && (
              <Badge variant="secondary" className="ml-1">
                {formatNumber(analyzedCount)}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="insights" className="gap-2">
            <Layers className="h-4 w-4" />
            الرؤى المجمعة
          </TabsTrigger>
        </TabsList>

        {/* ---------- Tab 1: Individual Analysis ---------- */}
        <TabsContent value="analyze" className="space-y-6">
          {/* Selection panel */}
          <Card>
            <CardHeader>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    الشكاوى غير المحللة
                  </CardTitle>
                  <CardDescription className="text-xs mt-1">
                    اختر الشكاوى لتشغيل التحليل الذكي عليها (حد أقصى 10 لكل دفعة)
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={selectAll}
                    disabled={unanalyzed.length === 0 || analyzing}
                  >
                    تحديد الكل
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearSelection}
                    disabled={selectedIds.size === 0 || analyzing}
                  >
                    إلغاء التحديد
                  </Button>
                  <Button
                    size="sm"
                    onClick={runAnalysis}
                    disabled={
                      analyzing || selectedIds.size === 0 || loadingUnanalyzed
                    }
                  >
                    {analyzing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    {analyzing
                      ? "جاري التحليل..."
                      : `تحليل المختارة (${formatNumber(selectedIds.size)})`}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loadingUnanalyzed ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : unanalyzed.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-2" />
                  <p className="font-medium">لا توجد شكاوى بحاجة للتحليل</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    تم تحليل جميع الشكاوى المتاحة
                  </p>
                </div>
              ) : (
                <ScrollArea className="h-[420px] pr-2">
                  <div className="space-y-2">
                    {unanalyzed.map((c) => (
                      <label
                        key={c.id}
                        htmlFor={`chk-${c.id}`}
                        className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 cursor-pointer transition-colors"
                      >
                        <Checkbox
                          id={`chk-${c.id}`}
                          checked={selectedIds.has(c.id)}
                          onCheckedChange={() => toggleSelect(c.id)}
                          className="mt-1"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs text-muted-foreground">
                              {c.complaintNumber}
                            </span>
                            <Badge className={statusBadgeClass(c.status)}>
                              {STATUS_LABELS[c.status] || c.status}
                            </Badge>
                            {c.region?.name && (
                              <Badge variant="outline" className="text-xs">
                                {c.region.name}
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm font-medium mt-1 line-clamp-1">
                            {c.subject}
                          </p>
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
                            {c.description}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatDate(c.receivedDate)} • {c.channel}
                          </p>
                        </div>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>

          {/* Analyzed results */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Brain className="h-5 w-5 text-primary" />
                نتائج التحليل
              </h2>
              <span className="text-sm text-muted-foreground">
                {formatNumber(analyzed.length)} شكوى محللة
              </span>
            </div>

            {loadingAnalyzed ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-72 w-full" />
                ))}
              </div>
            ) : analyzed.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <Sparkles className="h-10 w-10 text-muted-foreground mb-2" />
                  <p className="font-medium">لا توجد نتائج تحليل بعد</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    اختر شكاوى من القائمة أعلاه وابدأ التحليل لعرض النتائج هنا
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {analyzed.map((c) => (
                  <AnalyzedCard
                    key={c.id}
                    complaint={c}
                    onApprove={() => approve(c.id)}
                    onModify={() => openModify(c)}
                    onDismiss={() => dismiss(c.id)}
                    onReanalyze={() => reanalyzeOne(c.id)}
                    isPending={approvingId === c.id || analyzing}
                  />
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ---------- Tab 2: Batch Insights ---------- */}
        <TabsContent value="insights" className="space-y-6">
          {/* Executive summary */}
          <Card>
            <CardHeader>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    الملخص التنفيذي
                  </CardTitle>
                  <CardDescription className="text-xs mt-1">
                    ملخص مولّد بالذكاء الاصطناعي بناءً على الشكاوى المحللة
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  onClick={generateSummary}
                  disabled={generatingSummary || stats.total === 0}
                  variant="outline"
                >
                  {generatingSummary ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {executiveSummary ? "إعادة التوليد" : "توليد الملخص"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {generatingSummary ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : executiveSummary ? (
                <div className="rounded-lg bg-muted/40 p-4">
                  <p className="text-sm leading-relaxed whitespace-pre-line">
                    {executiveSummary}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <FileText className="h-10 w-10 text-muted-foreground mb-2" />
                  <p className="font-medium">لا يوجد ملخص تنفيذي بعد</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    اضغط على &quot;توليد الملخص&quot; لإنشاء ملخص آلي للشكاوى
                    المحللة
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {loadingInsights ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-72 w-full" />
              ))}
            </div>
          ) : !insights || insights.totals.analyzed === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Layers className="h-10 w-10 text-muted-foreground mb-2" />
                <p className="font-medium">لا توجد رؤى متاحة</p>
                <p className="text-sm text-muted-foreground mt-1">
                  قم بتحليل بعض الشكاوى أولاً لعرض الرؤى المجمعة
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Charts row */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Sentiment pie */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Heart className="h-4 w-4 text-primary" />
                      توزيع المشاعر
                    </CardTitle>
                    <CardDescription className="text-xs">
                      تحليل مشاعر الشكاوى المحللة
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie
                          data={insights.sentimentDistribution}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={90}
                          innerRadius={45}
                          label={(entry: { key?: string }) =>
                            sentimentMeta(entry.key).label
                          }
                        >
                          {insights.sentimentDistribution.map((entry) => (
                            <Cell
                              key={entry.key}
                              fill={
                                SENTIMENT_PIE_COLORS[entry.key] || "#94a3b8"
                              }
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            borderRadius: 12,
                            fontSize: 12,
                            textAlign: "right",
                          }}
                        />
                        <Legend
                          wrapperStyle={{ fontSize: 12 }}
                          iconType="circle"
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Severity bar */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Gauge className="h-4 w-4 text-primary" />
                      توزيع درجة الخطورة
                    </CardTitle>
                    <CardDescription className="text-xs">
                      تصنيف الشكاوى حسب درجة الخطورة (0-100)
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={insights.severityBuckets}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="#e2e8f0"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="name"
                          tick={{ fontSize: 10 }}
                          angle={-15}
                          textAnchor="end"
                          height={60}
                        />
                        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                        <Tooltip
                          contentStyle={{
                            borderRadius: 12,
                            fontSize: 12,
                            textAlign: "right",
                          }}
                        />
                        <Bar
                          dataKey="value"
                          name="عدد الشكاوى"
                          radius={[6, 6, 0, 0]}
                        >
                          {insights.severityBuckets.map((_, i) => (
                            <Cell
                              key={i}
                              fill={SEVERITY_GAUGE_COLORS[i % 4]}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Keywords bar */}
                <Card className="lg:col-span-2">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Tag className="h-4 w-4 text-primary" />
                      الكلمات المفتاحية الأكثر تكراراً
                    </CardTitle>
                    <CardDescription className="text-xs">
                      استخراج آلي للمواضيع المتكررة في نصوص الشكاوى
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {insights.topKeywords.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        لا توجد كلمات مفتاحية كافية للعرض
                      </p>
                    ) : (
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart
                          data={insights.topKeywords}
                          layout="vertical"
                          margin={{ left: 20, right: 20 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="#e2e8f0"
                            horizontal={false}
                          />
                          <XAxis
                            type="number"
                            tick={{ fontSize: 11 }}
                            allowDecimals={false}
                          />
                          <YAxis
                            type="category"
                            dataKey="word"
                            tick={{ fontSize: 11 }}
                            width={110}
                          />
                          <Tooltip
                            contentStyle={{
                              borderRadius: 12,
                              fontSize: 12,
                              textAlign: "right",
                            }}
                          />
                          <Bar
                            dataKey="count"
                            name="التكرار"
                            fill="#0d9488"
                            radius={[0, 6, 6, 0]}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Recurring themes + High severity */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Layers className="h-4 w-4 text-primary" />
                      أبرز المواضيع المتكررة
                    </CardTitle>
                    <CardDescription className="text-xs">
                      التصنيفات الأكثر شيوعاً ومتوسط خطورتها
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {insights.recurringThemes.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">
                          لا توجد مواضيع متكررة
                        </p>
                      ) : (
                        insights.recurringThemes.map((t) => {
                          const sev = severityMeta(t.avgSeverity);
                          return (
                            <div
                              key={t.name}
                              className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">
                                  {t.name}
                                </p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {formatNumber(t.count)} شكوى
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge className={sev.bg + " " + sev.text}>
                                  خطورة {sev.label}
                                </Badge>
                                <span className="text-xs font-mono text-muted-foreground">
                                  {t.avgSeverity}/100
                                </span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-rose-500" />
                      الشكاوى ذات الخطورة العالية
                    </CardTitle>
                    <CardDescription className="text-xs">
                      شكاوى بدرجة خطورة 70 فأعلى - تستوجب المراجعة العاجلة
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="h-[260px] pr-2">
                      <div className="space-y-2">
                        {insights.highSeverityComplaints.length === 0 ? (
                          <p className="text-sm text-muted-foreground text-center py-6">
                            لا توجد شكاوى ذات خطورة عالية
                          </p>
                        ) : (
                          insights.highSeverityComplaints.map((c) => {
                            const sev = severityMeta(c.aiSeverityScore ?? 0);
                            return (
                              <div
                                key={c.id}
                                className="flex items-start justify-between gap-3 p-3 rounded-lg border border-border"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-mono text-xs text-muted-foreground">
                                      {c.complaintNumber}
                                    </span>
                                    {c.region && (
                                      <Badge
                                        variant="outline"
                                        className="text-xs"
                                      >
                                        {c.region}
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="text-sm font-medium mt-1 line-clamp-2">
                                    {c.subject}
                                  </p>
                                  {c.aiClassification && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                      التصنيف: {c.aiClassification}
                                    </p>
                                  )}
                                </div>
                                <div className="flex flex-col items-end gap-1 shrink-0">
                                  <Badge className={sev.bg + " " + sev.text}>
                                    {sev.label}
                                  </Badge>
                                  <span className="text-xs font-mono font-bold text-rose-600 dark:text-rose-400">
                                    {c.aiSeverityScore?.toFixed(0)}
                                  </span>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </ScrollArea>
                  </CardContent>
                </Card>
              </div>

              {/* Duplicate clusters */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Copy className="h-4 w-4 text-primary" />
                    المجموعات المتكررة المحتملة
                  </CardTitle>
                  <CardDescription className="text-xs">
                    شكاوى ذات نصوص متشابهة قد تكون مكررة - يلزم المراجعة اليدوية
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {insights.duplicateClusters.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      لا توجد مجموعات متكررة محتملة
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {insights.duplicateClusters.map((cluster, i) => (
                        <div
                          key={i}
                          className="p-3 rounded-lg border border-amber-200 bg-amber-50/40 dark:bg-amber-900/10 dark:border-amber-800"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                              {formatNumber(cluster.count)} شكاوى متشابهة
                            </Badge>
                          </div>
                          <div className="space-y-1.5">
                            {cluster.complaints.map((cc) => (
                              <div
                                key={cc.id}
                                className="text-xs flex items-start gap-2"
                              >
                                <span className="font-mono text-muted-foreground shrink-0">
                                  {cc.complaintNumber}
                                </span>
                                <span className="line-clamp-1">{cc.subject}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* Modify dialog */}
      <Dialog
        open={!!modifyTarget}
        onOpenChange={(open) => {
          if (!open) setModifyTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-primary" />
              تعديل اقتراح الذكاء الاصطناعي
            </DialogTitle>
            <DialogDescription>
              عدّل القيم المقترحة قبل تطبيقها على الشكوى. القيم المتبقية فارغة
              ستبقى دون تغيير.
            </DialogDescription>
          </DialogHeader>
          {modifyTarget && (
            <div className="space-y-4">
              <div className="text-xs text-muted-foreground bg-muted/40 p-2 rounded">
                <span className="font-mono">
                  {modifyTarget.complaintNumber}
                </span>{" "}
                — {modifyTarget.subject}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">التصنيف المقترح</label>
                <Select
                  value={modifyClassification}
                  onValueChange={setModifyClassification}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="اختر التصنيف" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {CLASSIFICATION_CATALOG.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  اقتراح الذكاء الاصطناعي:{" "}
                  <span className="font-medium">
                    {modifyTarget.aiClassification || "—"}
                  </span>
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">درجة الخطورة</label>
                  <Select
                    value={modifySeverity}
                    onValueChange={setModifySeverity}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="غير محدد" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">منخفضة</SelectItem>
                      <SelectItem value="medium">متوسطة</SelectItem>
                      <SelectItem value="high">عالية</SelectItem>
                      <SelectItem value="critical">حرجة</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">الأولوية</label>
                  <Select
                    value={modifyPriority}
                    onValueChange={setModifyPriority}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="غير محدد" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">منخفضة</SelectItem>
                      <SelectItem value="medium">متوسطة</SelectItem>
                      <SelectItem value="high">عالية</SelectItem>
                      <SelectItem value="critical">حرجة</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setModifyTarget(null)}
              disabled={approvingId !== null}
            >
              إلغاء
            </Button>
            <Button
              onClick={submitModify}
              disabled={
                approvingId !== null ||
                (!modifyClassification && !modifySeverity && !modifyPriority)
              }
            >
              {approvingId ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              تطبيق التعديلات
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- Sub Components ----------
function StatCard({
  title,
  value,
  icon,
  color,
  loading,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  color: string;
  loading?: boolean;
}) {
  return (
    <Card className="card-hover">
      <CardContent className="p-4 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{title}</p>
          {loading ? (
            <Skeleton className="h-7 w-20 mt-1" />
          ) : (
            <p className="text-2xl font-bold mt-1 tabular-nums">{value}</p>
          )}
        </div>
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-xl shrink-0 ${color}`}
        >
          {icon}
        </div>
      </CardContent>
    </Card>
  );
}

function AnalyzedCard({
  complaint,
  onApprove,
  onModify,
  onDismiss,
  onReanalyze,
  isPending,
}: {
  complaint: Complaint;
  onApprove: () => void;
  onModify: () => void;
  onDismiss: () => void;
  onReanalyze: () => void;
  isPending: boolean;
}) {
  const conf = complaint.aiConfidence ?? 0;
  const severityScore = complaint.aiSeverityScore ?? 0;
  const sev = severityMeta(severityScore);
  const sent = sentimentMeta(complaint.aiSentiment);

  return (
    <Card className="card-hover flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs text-muted-foreground">
                {complaint.complaintNumber}
              </span>
              <Badge className={statusBadgeClass(complaint.status)}>
                {STATUS_LABELS[complaint.status] || complaint.status}
              </Badge>
              {complaint.region?.name && (
                <Badge variant="outline" className="text-xs">
                  {complaint.region.name}
                </Badge>
              )}
            </div>
            <CardTitle className="text-sm mt-2 line-clamp-2">
              {complaint.subject}
            </CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-4">
        {/* Description preview */}
        <p className="text-xs text-muted-foreground line-clamp-2">
          {complaint.description}
        </p>

        {/* AI Summary */}
        {complaint.aiSummary && (
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <FileText className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-semibold">الملخص</span>
            </div>
            <p className="text-xs leading-relaxed">{complaint.aiSummary}</p>
          </div>
        )}

        {/* Proposed classification */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Tag className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-semibold">التصنيف المقترح</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Badge variant="secondary" className="text-xs">
              {complaint.aiClassification || "غير مصنف"}
            </Badge>
            {complaint.classification?.name &&
              complaint.classification.name !==
                complaint.aiClassification && (
                <span className="text-xs text-muted-foreground">
                  الحالي: {complaint.classification.name}
                </span>
              )}
          </div>
        </div>

        {/* Confidence */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-semibold">درجة الثقة</span>
            </div>
            <span
              className="text-xs font-mono font-bold"
              style={{ color: confidenceColor(conf) }}
            >
              {formatPercent(conf * 100)}
            </span>
          </div>
          <Progress
            value={conf * 100}
            className={confidenceBarClass(conf)}
          />
        </div>

        {/* Sentiment + Severity row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Heart className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-semibold">المشاعر</span>
            </div>
            <Badge className={sent.bg + " " + sent.text}>{sent.label}</Badge>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-semibold">درجة الخطورة</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge className={sev.bg + " " + sev.text}>{sev.label}</Badge>
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${severityScore}%`,
                    backgroundColor: sev.color,
                  }}
                />
              </div>
              <span className="text-xs font-mono font-bold">
                {severityScore.toFixed(0)}
              </span>
            </div>
          </div>
        </div>

        {/* Reasoning */}
        {complaint.aiReasoning && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Brain className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-semibold">أسباب الاقتراح</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {complaint.aiReasoning}
            </p>
          </div>
        )}

        {complaint.aiAnalyzedAt && (
          <p className="text-xs text-muted-foreground">
            تاريخ التحليل: {formatDateTime(complaint.aiAnalyzedAt)}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2 mt-auto border-t">
          <Button
            size="sm"
            variant="default"
            onClick={onApprove}
            disabled={isPending}
            className="flex-1"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            اعتماد
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onModify}
            disabled={isPending}
            className="flex-1"
          >
            <Pencil className="h-4 w-4" />
            تعديل
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDismiss}
            disabled={isPending}
          >
            <XCircle className="h-4 w-4" />
            تجاهل
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onReanalyze}
            disabled={isPending}
            title="إعادة التحليل"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
