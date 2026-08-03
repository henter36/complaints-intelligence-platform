"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  ShieldAlert, ShieldCheck, AlertTriangle, Info, ChevronLeft, ChevronRight,
  RefreshCw,
} from "lucide-react";
import { isAbortError } from "@/lib/abort";

// ---------- Types ----------

type TextRiskSignalItem = Readonly<{
  id: string;
  complaintId: string;
  signalType: string;
  ruleId: string;
  ruleVersion: string;
  title: string;
  severity: string;
  confidenceScore: number;
  certainty: string;
  isOngoing: boolean | null;
  evidenceSpans: unknown;
  reviewStatus: string;
  region: string | null;
  facility: string | null;
  department: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewReason: string | null;
}>;

type ListResult = Readonly<{
  items: TextRiskSignalItem[];
  page: number;
  pageSize: number;
  total: number;
}>;

// ---------- Helpers ----------

const SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: "حرج",
  HIGH: "عالٍ",
  MEDIUM: "متوسط",
  LOW: "منخفض",
};

const REVIEW_STATUS_LABELS: Record<string, string> = {
  PENDING_REVIEW: "قيد المراجعة",
  CONFIRMED: "مؤكد",
  DISMISSED: "مرفوض",
  DUPLICATE: "مكرر",
  NEEDS_MORE_DATA: "يحتاج بيانات",
};

const CERTAINTY_LABELS: Record<string, string> = {
  CONFIRMED_IN_TEXT: "مؤكد في النص",
  SUSPECTED: "اشتباه",
  ALLEGED: "ادعاء",
  HISTORICAL_RESOLVED: "حدث سابق",
  UNCLEAR: "غير محدد",
};

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  SERVICE_OUTAGE: "انقطاع خدمة",
  PROCEDURE_FAILURE: "إخفاق إجرائي",
  PUBLIC_HEALTH: "صحة عامة",
  POISONING: "تسمم",
  SENTENCE_EXPIRY: "انتهاء محكومية",
  LEGAL_DELAY: "تأخر قانوني",
  SECURITY_INCIDENT: "حادثة أمنية",
  MEDICATION_SHORTAGE: "نقص دواء",
  FOOD_OR_WATER_SAFETY: "سلامة غذاء/مياه",
  INFRASTRUCTURE_FAILURE: "إخفاق بنية تحتية",
};

export function getSeverityVariant(
  severity: string
): "destructive" | "secondary" | "outline" | "default" {
  if (severity === "CRITICAL") return "destructive";
  if (severity === "HIGH") return "default";
  if (severity === "MEDIUM") return "secondary";
  return "outline";
}

export function getSeverityClassName(severity: string): string {
  if (severity === "CRITICAL") return "text-red-700";
  if (severity === "HIGH") return "text-orange-600";
  if (severity === "MEDIUM") return "text-yellow-600";
  return "text-muted-foreground";
}

function parseEvidenceSpans(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of raw) {
    if (typeof s === "string" && !seen.has(s)) {
      seen.add(s);
      result.push(s);
    }
  }
  return result;
}

export function getReviewStatusVariant(
  status: string
): "default" | "secondary" | "outline" {
  if (status === "CONFIRMED") return "default";
  if (status === "DISMISSED") return "secondary";
  return "outline";
}

function formatPercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// ---------- Review Dialog ----------

type ReviewAction = "CONFIRMED" | "DISMISSED" | "DUPLICATE" | "NEEDS_MORE_DATA";

const REVIEW_ACTION_LABELS: Record<ReviewAction, string> = {
  CONFIRMED: "تأكيد",
  DISMISSED: "رفض",
  DUPLICATE: "مكرر",
  NEEDS_MORE_DATA: "يحتاج بيانات",
};

type ReviewDialogProps = Readonly<{
  signal: TextRiskSignalItem | null;
  onClose: () => void;
  onSubmit: (id: string, action: ReviewAction, reason: string) => Promise<void>;
}>;

function ReviewDialog({ signal, onClose, onSubmit }: ReviewDialogProps) {
  const [action, setAction] = useState<ReviewAction>("CONFIRMED");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!signal) return;
    if (action === "DISMISSED" && !reason.trim()) {
      setError("سبب الرفض مطلوب");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onSubmit(signal.id, action, reason);
      onClose();
    } catch {
      setError("تعذر حفظ المراجعة. حاول مجددًا.");
    } finally {
      setLoading(false);
    }
  }

  if (!signal) return null;

  const spans = parseEvidenceSpans(signal.evidenceSpans);

  return (
    <Dialog open={Boolean(signal)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" aria-hidden="true" />
            مراجعة إشارة الخطر
          </DialogTitle>
          <DialogDescription>
            راجع الإشارة وأكد أو ارفض أو صنّفها بدقة.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Disclaimer */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-2 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>هذه إشارة آلية مساعدة مستخرجة من نص الشكوى، ولا تعد إثباتًا أو قرارًا نهائيًا.</span>
          </div>

          {/* Signal details */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">النوع:</span>{" "}
              <span className="font-medium">{SIGNAL_TYPE_LABELS[signal.signalType] ?? signal.signalType}</span>
            </div>
            <div>
              <span className="text-muted-foreground">الخطورة:</span>{" "}
              <Badge variant={getSeverityVariant(signal.severity)} className="text-xs">
                {SEVERITY_LABELS[signal.severity] ?? signal.severity}
              </Badge>
            </div>
            <div>
              <span className="text-muted-foreground">اليقينية:</span>{" "}
              <span>{CERTAINTY_LABELS[signal.certainty] ?? signal.certainty}</span>
            </div>
            <div>
              <span className="text-muted-foreground">الثقة:</span>{" "}
              <span>{formatPercent(signal.confidenceScore)}</span>
            </div>
            {signal.region && (
              <div>
                <span className="text-muted-foreground">المنطقة:</span>{" "}
                <span>{signal.region}</span>
              </div>
            )}
            {signal.isOngoing !== null && (
              <div>
                <span className="text-muted-foreground">الحالة:</span>{" "}
                <span>{signal.isOngoing ? "مستمر" : "منتهٍ"}</span>
              </div>
            )}
          </div>

          {/* Evidence spans */}
          {spans.length > 0 && (
            <div>
              <p className="text-sm font-medium mb-1.5">الأدلة المستخرجة (مُنقَّحة):</p>
              {spans.map((span) => (
                <div key={`${signal.id}:${span}`} className="bg-muted rounded-md p-2 text-sm font-mono leading-relaxed">
                  {span}
                </div>
              ))}
            </div>
          )}

          {/* Complaint link */}
          <div className="text-sm">
            <span className="text-muted-foreground">معرف الشكوى:</span>{" "}
            <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">{signal.complaintId}</code>
          </div>

          {/* Review action */}
          <div className="space-y-2">
            <Label htmlFor="review-action">إجراء المراجعة</Label>
            <Select
              value={action}
              onValueChange={(v) => setAction(v as ReviewAction)}
            >
              <SelectTrigger id="review-action" aria-label="إجراء المراجعة">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REVIEW_ACTION_LABELS) as ReviewAction[]).map((a) => (
                  <SelectItem key={a} value={a}>{REVIEW_ACTION_LABELS[a]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Reason */}
          <div className="space-y-2">
            <Label htmlFor="review-reason">
              {action === "DISMISSED" ? "سبب الرفض (مطلوب)" : "ملاحظات (اختياري)"}
            </Label>
            <Textarea
              id="review-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={action === "DISMISSED" ? "اذكر سبب رفض هذه الإشارة..." : "ملاحظات إضافية..."}
              rows={3}
              className="resize-none"
              aria-required={action === "DISMISSED"}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          )}
        </div>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>إلغاء</Button>
          <Button onClick={handleSubmit} disabled={loading} aria-busy={loading}>
            {loading ? "جارٍ الحفظ..." : "حفظ المراجعة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Main Screen ----------

export function TextRisks() {
  const [items, setItems] = useState<TextRiskSignalItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewingSignal, setReviewingSignal] = useState<TextRiskSignalItem | null>(null);

  // Filters
  const [filterSeverity, setFilterSeverity] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterType, setFilterType] = useState("all");

  const pageSize = 20;
  const requestGenerationRef = useRef(0);

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    if (filterSeverity !== "all") params.set("severity", filterSeverity);
    if (filterStatus !== "all") params.set("reviewStatus", filterStatus);
    if (filterType !== "all") params.set("signalType", filterType);
    return params.toString();
  }, [page, filterSeverity, filterStatus, filterType]);

  const fetchData = useCallback(async (signal: AbortSignal) => {
    const requestId = ++requestGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/analytics/text-risks?${buildQuery()}`, { signal });
      if (signal.aborted || requestId !== requestGenerationRef.current) return;
      if (!response.ok) throw new Error("fetch-failed");
      const data = await response.json() as ListResult;
      if (signal.aborted || requestId !== requestGenerationRef.current) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      if (isAbortError(err) || signal.aborted || requestId !== requestGenerationRef.current) return;
      setError("تعذر جلب إشارات الخطر. يرجى المحاولة لاحقًا.");
    } finally {
      if (!signal.aborted && requestId === requestGenerationRef.current) {
        setLoading(false);
      }
    }
  }, [buildQuery]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        void fetchData(controller.signal);
      }
    });
    return () => controller.abort();
  }, [fetchData]);

  async function handleReview(id: string, action: ReviewAction, reason: string) {
    const response = await fetch(`/api/analytics/text-risks/${id}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus: action, reviewReason: reason || undefined }),
    });
    if (!response.ok) throw new Error("review-failed");
    // Refresh list
    const controller = new AbortController();
    await fetchData(controller.signal);
  }

  function handleFilterChange() {
    setPage(1);
  }

  const totalPages = Math.ceil(total / pageSize);

  // Summary counts
  const criticalCount = items.filter((i) => i.severity === "CRITICAL").length;
  const pendingCount = items.filter((i) => i.reviewStatus === "PENDING_REVIEW").length;

  return (
    <div className="space-y-6" dir="rtl">
      <PageHeader
        title="مراجعة إشارات الخطر"
        description="إشارات المخاطر الحرجة المكتشفة بواسطة محرك قواعد النص"
      />

      {/* Disclaimer banner */}
      <div
        className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800 text-sm"
        role="note"
        aria-label="تنبيه مهم"
      >
        <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span>
          هذه إشارات آلية مساعدة مستخرجة من نص الشكوى، ولا تعد إثباتًا أو قرارًا نهائيًا.
          تحتاج كل إشارة مراجعة من متخصص مختص قبل اتخاذ أي إجراء.
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <ShieldAlert className="h-8 w-8 text-red-600" aria-hidden="true" />
              <div>
                <p className="text-2xl font-bold">{total}</p>
                <p className="text-sm text-muted-foreground">إجمالي الإشارات</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
              <div>
                <p className="text-2xl font-bold text-destructive">{criticalCount}</p>
                <p className="text-sm text-muted-foreground">حرجة في الصفحة الحالية</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-8 w-8 text-amber-600" aria-hidden="true" />
              <div>
                <p className="text-2xl font-bold text-amber-600">{pendingCount}</p>
                <p className="text-sm text-muted-foreground">قيد المراجعة في الصفحة الحالية</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">تصفية الإشارات</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="filter-severity">الخطورة</Label>
              <Select
                value={filterSeverity}
                onValueChange={(v) => { setFilterSeverity(v); handleFilterChange(); }}
              >
                <SelectTrigger id="filter-severity" aria-label="تصفية حسب الخطورة">
                  <SelectValue placeholder="الكل" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">الكل</SelectItem>
                  {Object.entries(SEVERITY_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="filter-status">حالة المراجعة</Label>
              <Select
                value={filterStatus}
                onValueChange={(v) => { setFilterStatus(v); handleFilterChange(); }}
              >
                <SelectTrigger id="filter-status" aria-label="تصفية حسب الحالة">
                  <SelectValue placeholder="الكل" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">الكل</SelectItem>
                  {Object.entries(REVIEW_STATUS_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="filter-type">نوع الإشارة</Label>
              <Select
                value={filterType}
                onValueChange={(v) => { setFilterType(v); handleFilterChange(); }}
              >
                <SelectTrigger id="filter-type" aria-label="تصفية حسب النوع">
                  <SelectValue placeholder="الكل" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">الكل</SelectItem>
                  {Object.entries(SIGNAL_TYPE_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span>الإشارات المكتشفة</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { const ctrl = new AbortController(); void fetchData(ctrl.signal); }}
              aria-label="تحديث القائمة"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </Button>
          </CardTitle>
          <CardDescription className="text-xs">
            إجمالي {total} إشارة — صفحة {page} من {totalPages || 1}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading && (
            <div className="space-y-2 p-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          )}

          {!loading && error && (
            <div
              className="flex items-center gap-3 p-6 text-destructive"
              role="alert"
            >
              <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
              <p>{error}</p>
            </div>
          )}

          {!loading && !error && items.length === 0 && (
            <div className="flex flex-col items-center gap-3 p-10 text-muted-foreground">
              <ShieldCheck className="h-10 w-10" aria-hidden="true" />
              <p>لا توجد إشارات مطابقة للفلاتر المحددة</p>
            </div>
          )}

          {!loading && !error && items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" role="table" aria-label="إشارات الخطر">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">النوع / العنوان</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">الخطورة</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">اليقينية</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">الثقة</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">المنطقة</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">الحالة</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((signal) => {
                    const spans = parseEvidenceSpans(signal.evidenceSpans);
                    return (
                      <tr
                        key={signal.id}
                        className="border-b last:border-0 hover:bg-muted/30"
                      >
                        <td className="py-2 px-3">
                          <div className="font-medium">{signal.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {SIGNAL_TYPE_LABELS[signal.signalType] ?? signal.signalType}
                          </div>
                          {spans[0] && (
                            <div className="text-xs text-muted-foreground mt-1 font-mono truncate max-w-xs">
                              {spans[0]}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <Badge variant={getSeverityVariant(signal.severity)} className="text-xs">
                            {SEVERITY_LABELS[signal.severity] ?? signal.severity}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 text-center text-xs">
                          {CERTAINTY_LABELS[signal.certainty] ?? signal.certainty}
                        </td>
                        <td className="py-2 px-3 text-center tabular-nums text-xs">
                          {formatPercent(signal.confidenceScore)}
                        </td>
                        <td className="py-2 px-3 text-xs">
                          {signal.region ?? "—"}
                          {signal.department && (
                            <div className="text-muted-foreground">{signal.department}</div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <Badge
                            variant={getReviewStatusVariant(signal.reviewStatus)}
                            className="text-xs"
                          >
                            {REVIEW_STATUS_LABELS[signal.reviewStatus] ?? signal.reviewStatus}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setReviewingSignal(signal)}
                            aria-label={`مراجعة إشارة ${signal.title}`}
                          >
                            <Info className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            aria-label="الصفحة السابقة"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
          <span className="text-sm text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            aria-label="الصفحة التالية"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}

      {/* Review dialog */}
      <ReviewDialog
        key={reviewingSignal?.id ?? "none"}
        signal={reviewingSignal}
        onClose={() => setReviewingSignal(null)}
        onSubmit={handleReview}
      />
    </div>
  );
}
