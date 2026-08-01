"use client";

import { useEffect, useState, useMemo, Fragment, useCallback, useRef } from "react";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  History,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  Clock,
  RotateCcw,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  User,
  Database,
  TrendingUp,
  Percent,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Eye,
  Calendar,
  ArrowRightLeft,
  PlayCircle,
  Trash2,
} from "lucide-react";
import {
  formatNumber,
  formatDate,
  formatDateTime,
} from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";

// ---------- Types ----------
interface UserRef {
  name: string;
  email: string;
}

interface ImportBatch {
  id: string;
  fileName: string;
  fileSize: number;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  entity?: string | null;
  status: string;
  serverStatus?: string;
  canResume?: boolean;
  canDelete?: boolean;
  totalRecords: number;
  validRecords: number;
  newRecords: number;
  updatedRecords: number;
  duplicateRecords: number;
  rejectedRecords: number;
  incompleteRecords: number;
  errorReport?: string | null;
  columnMapping?: string | null;
  uploadedById: string;
  uploadedBy: UserRef;
  approvedById?: string | null;
  approvedBy?: UserRef | null;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- Constants ----------
const STATUS_META: Record<
  string,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  approved: {
    label: "معتمد",
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800",
    icon: CheckCircle2,
  },
  rejected: {
    label: "مرفوض",
    className:
      "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 border-rose-200 dark:border-rose-800",
    icon: XCircle,
  },
  pending: {
    label: "بانتظار المراجعة",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800",
    icon: Clock,
  },
  preview: {
    label: "معاينة",
    className:
      "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300 border-sky-200 dark:border-sky-800",
    icon: Eye,
  },
  validating: {
    label: "قيد التحقق",
    className:
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border-purple-200 dark:border-purple-800",
    icon: Loader2,
  },
  rolling_back: {
    label: "جار التراجع",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800",
    icon: Loader2,
  },
  error: {
    label: "خطأ",
    className:
      "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 border-red-200 dark:border-red-800",
    icon: AlertTriangle,
  },
};

const PERIOD_LABELS: Record<string, string> = {
  daily: "يومي",
  weekly: "أسبوعي",
  monthly: "شهري",
  custom: "مخصص",
};

const FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "الكل" },
  { value: "approved", label: "معتمد" },
  { value: "rejected", label: "مرفوض" },
  { value: "pending", label: "بانتظار المراجعة" },
  { value: "preview", label: "معاينة" },
];

// ---------- Helpers ----------
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} ب`;
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024))} ك.ب`;
  return `${formatNumber(Math.round((bytes / (1024 * 1024)) * 10) / 10)} م.ب`;
}

function safeParse<T>(raw?: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function getStatusMeta(status: string) {
  return (
    STATUS_META[status] || {
      label: status,
      className: "bg-muted text-muted-foreground",
      icon: Clock,
    }
  );
}

// ---------- Stats Card ----------
interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  iconClass: string;
  sub?: string;
}

function StatCard({ label, value, icon, iconClass, sub }: StatCardProps) {
  return (
    <Card className="card-hover">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-11 w-11 items-center justify-center rounded-xl shrink-0 ${iconClass}`}
          >
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground truncate">{label}</p>
            <p className="text-2xl font-bold tabular-nums truncate">{value}</p>
            {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Status Badge ----------
function StatusBadge({ status }: { status: string }) {
  const meta = getStatusMeta(status);
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={`gap-1 ${meta.className}`}>
      <Icon
        className={`h-3 w-3 ${status === "validating" ? "animate-spin" : ""}`}
      />
      {meta.label}
    </Badge>
  );
}

// ---------- User chip ----------
function UserChip({ user }: { user?: UserRef | null }) {
  if (!user) return <span className="text-muted-foreground">—</span>;
  const initials = user.name
    .split(" ")
    .slice(0, 2)
    .map((s) => s[0])
    .join("");
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-semibold">
              {initials}
            </div>
            <span className="text-xs">{user.name}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">{user.email}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------- Expandable Row Content ----------
interface ErrorEntry {
  row?: number;
  field?: string;
  message?: string;
  value?: string;
}

interface ExpandedDetailsProps {
  batch: ImportBatch;
}

function ExpandedDetails({ batch }: ExpandedDetailsProps) {
  const errors = safeParse<ErrorEntry[]>(batch.errorReport);
  const mapping = safeParse<Record<string, string>>(batch.columnMapping);

  return (
    <div className="bg-muted/30 p-4 space-y-4 border-t">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Error report */}
        <div className="space-y-2">
          <h5 className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            تقرير الأخطاء
          </h5>
          {errors && errors.length > 0 ? (
            <div className="max-h-48 overflow-y-auto rounded-md border bg-background">
              <ul className="divide-y text-xs">
                {errors.slice(0, 50).map((err, i) => (
                  <li key={i} className="p-2 flex items-start gap-2">
                    <Badge
                      variant="outline"
                      className="bg-rose-50 text-rose-700 dark:bg-rose-900/20 dark:text-rose-300 text-[10px] py-0 px-1"
                    >
                      {err.row ? `#${err.row}` : "—"}
                    </Badge>
                    <span className="flex-1">
                      {err.field && (
                        <span className="font-medium">{err.field}: </span>
                      )}
                      {err.message || "خطأ غير محدد"}
                      {err.value && (
                        <span className="text-muted-foreground">
                          {" "}
                          ({err.value})
                        </span>
                      )}
                    </span>
                  </li>
                ))}
                {errors.length > 50 && (
                  <li className="p-2 text-center text-muted-foreground">
                    + {formatNumber(errors.length - 50)} خطأ آخر...
                  </li>
                )}
              </ul>
            </div>
          ) : (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              لا توجد أخطاء مسجلة
            </div>
          )}
        </div>

        {/* Column mapping */}
        <div className="space-y-2">
          <h5 className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            <ArrowRightLeft className="h-3.5 w-3.5" />
            تعيين الأعمدة
          </h5>
          {mapping && Object.keys(mapping).length > 0 ? (
            <div className="max-h-48 overflow-y-auto rounded-md border bg-background">
              <ul className="divide-y text-xs">
                {Object.entries(mapping).map(([src, dst]) => (
                  <li
                    key={src}
                    className="p-2 flex items-center justify-between gap-2"
                  >
                    <span className="font-mono text-muted-foreground truncate">
                      {src}
                    </span>
                    <ChevronLeft className="h-3 w-3 text-primary shrink-0" />
                    <span className="font-medium text-right truncate">
                      {dst}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              لا يوجد تعيين أعمدة
            </div>
          )}
        </div>
      </div>

      {/* Detailed counts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-md border bg-background p-2 text-center">
          <p className="text-[10px] text-muted-foreground">سجلات صالحة</p>
          <p className="text-sm font-semibold text-emerald-600">
            {formatNumber(batch.validRecords)}
          </p>
        </div>
        <div className="rounded-md border bg-background p-2 text-center">
          <p className="text-[10px] text-muted-foreground">مكررة</p>
          <p className="text-sm font-semibold text-amber-600">
            {formatNumber(batch.duplicateRecords)}
          </p>
        </div>
        <div className="rounded-md border bg-background p-2 text-center">
          <p className="text-[10px] text-muted-foreground">ناقصة</p>
          <p className="text-sm font-semibold text-orange-600">
            {formatNumber(batch.incompleteRecords)}
          </p>
        </div>
        <div className="rounded-md border bg-background p-2 text-center">
          <p className="text-[10px] text-muted-foreground">مرفوضة</p>
          <p className="text-sm font-semibold text-rose-600">
            {formatNumber(batch.rejectedRecords)}
          </p>
        </div>
      </div>

      {batch.rejectionReason && (
        <div className="rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-800 p-3">
          <p className="text-xs font-semibold text-rose-700 dark:text-rose-300 mb-1">
            سبب الرفض
          </p>
          <p className="text-xs text-rose-600 dark:text-rose-400">
            {batch.rejectionReason}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------- Main Component ----------
export function ImportLog({ onResume }: Readonly<{ onResume?: (batchId: string) => void }>) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailsBatch, setDetailsBatch] = useState<ImportBatch | null>(null);
  const [rollbackBatch, setRollbackBatch] = useState<ImportBatch | null>(null);
  const [rollbackDialogOpen, setRollbackDialogOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [deleteBatch, setDeleteBatch] = useState<ImportBatch | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fetchRequestRef = useRef(0);

  const fetchBatches = useCallback(async (signal?: AbortSignal) => {
    const requestId = fetchRequestRef.current + 1;
    fetchRequestRef.current = requestId;
    const canUpdate = () => !signal?.aborted && fetchRequestRef.current === requestId;
    setLoading(true);
    let aborted = false;
    try {
      const res = await fetch("/api/import/history", { signal });
      if (!res.ok) throw new Error("فشل تحميل سجل الاستيراد");
      const data: ImportBatch[] = await res.json();
      if (canUpdate()) {
        setBatches(data);
      }
    } catch (err) {
      aborted = isAbortError(err);
      if (aborted) {
        return;
      }
      const msg = err instanceof Error ? err.message : "خطأ غير متوقع";
      toast({
        title: "خطأ",
        description: msg,
        variant: "destructive",
      });
    } finally {
      if (!aborted && canUpdate()) {
        setLoading(false);
      }
    }
  }, [toast]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        void fetchBatches(controller.signal);
      }
    });
    return () => {
      controller.abort();
    };
  }, [fetchBatches]);

  // Filtered batches
  const filtered = useMemo(() => {
    if (filter === "all") return batches;
    return batches.filter((b) => b.status === filter);
  }, [batches, filter]);

  // Stats
  const stats = useMemo(() => {
    const total = batches.length;
    const approved = batches.filter((b) => b.status === "approved");
    const totalRecords = approved.reduce((s, b) => s + b.totalRecords, 0);
    const approvalRate =
      total > 0 ? (approved.length / total) * 100 : 0;
    return {
      totalBatches: total,
      approvedCount: approved.length,
      totalRecords,
      approvalRate,
    };
  }, [batches]);

  // Filter counts
  const filterCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of batches) {
      map.set(b.status, (map.get(b.status) ?? 0) + 1);
    }
    map.set("all", batches.length);
    return map;
  }, [batches]);

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const handleRollbackClick = (batch: ImportBatch) => {
    setRollbackBatch(batch);
    setRollbackDialogOpen(true);
  };

  const confirmRollback = async () => {
    if (!rollbackBatch) return;
    setRollingBack(true);
    try {
      const response = await fetch(`/api/import/${rollbackBatch.id}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "تراجع يدوي من سجل الاستيراد" }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error?.message || "تعذر التراجع عن الدفعة");
      }

      toast({
        title: "تم التراجع عن الاستيراد",
        description: `تم التراجع عن الدفعة "${rollbackBatch.fileName}" بنجاح.`,
      });
      setRollbackDialogOpen(false);
      setRollbackBatch(null);
      void fetchBatches();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "فشل التراجع",
        description: error.message || "حدث خطأ غير متوقع",
      });
    } finally {
      setRollingBack(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteBatch) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/import/${deleteBatch.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "تعذر حذف دفعة الاستيراد");
      toast({
        title: "تم حذف الملف",
        description: payload.storageCleanup === "FAILED"
          ? "حُذفت الدفعة وسُجلت متابعة آمنة لتنظيف الملف."
          : "حُذفت الدفعة غير المعتمدة وبيانات معاينتها.",
      });
      setDeleteBatch(null);
      await fetchBatches();
    } catch (deleteError) {
      toast({
        variant: "destructive",
        title: "تعذر حذف الملف",
        description: deleteError instanceof Error ? deleteError.message : "حدث خطأ غير متوقع",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="سجل الاستيراد"
        description="سجل عمليات استيراد ملفات الشكاوى وحالتها"
        icon={<History className="h-6 w-6" />}
        actions={
          <Button variant="outline" onClick={() => void fetchBatches()} size="sm">
            <RefreshCw className="h-4 w-4" />
            تحديث
          </Button>
        }
      />

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))
        ) : (
          <>
            <StatCard
              label="إجمالي الدفعات"
              value={formatNumber(stats.totalBatches)}
              icon={<Database className="h-5 w-5" />}
              iconClass="bg-primary/10 text-primary"
            />
            <StatCard
              label="السجلات المستوردة"
              value={formatNumber(stats.totalRecords)}
              icon={<FileSpreadsheet className="h-5 w-5" />}
              iconClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
              sub="من الدفعات المعتمدة"
            />
            <StatCard
              label="نسبة الاعتماد"
              value={`${formatNumber(Math.round(stats.approvalRate * 10) / 10)}%`}
              icon={<Percent className="h-5 w-5" />}
              iconClass="bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300"
              sub={`${formatNumber(stats.approvedCount)} دفعة معتمدة`}
            />
            <StatCard
              label="متوسط السجلات لكل دفعة"
              value={formatNumber(
                stats.approvedCount > 0
                  ? Math.round(stats.totalRecords / stats.approvedCount)
                  : 0
              )}
              icon={<TrendingUp className="h-5 w-5" />}
              iconClass="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
            />
          </>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 flex-wrap">
        {FILTER_OPTIONS.map((opt) => {
          const count = filterCounts.get(opt.value) ?? 0;
          const active = filter === opt.value;
          return (
            <Button
              key={opt.value}
              variant={active ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(opt.value)}
              className="gap-1.5"
            >
              {opt.label}
              <Badge
                variant={active ? "secondary" : "outline"}
                className="ml-1 text-[10px] py-0 px-1.5"
              >
                {formatNumber(count)}
              </Badge>
            </Button>
          );
        })}
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-primary" />
            دفعات الاستيراد
          </CardTitle>
          <CardDescription className="text-xs">
            اضغط على الصف لعرض تفاصيل الأخطاء وتعيين الأعمدة
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-md" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
                <History className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="font-semibold text-lg">لا توجد دفعات</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {filter === "all"
                  ? "لم يتم استيراد أي ملفات بعد"
                  : "لا توجد دفعات بهذه الحالة"}
              </p>
            </div>
          ) : (
            <div className="max-h-[65vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead className="min-w-[180px]">اسم الملف</TableHead>
                    <TableHead className="min-w-[140px]">الفترة</TableHead>
                    <TableHead>الجهة</TableHead>
                    <TableHead className="text-center">السجلات</TableHead>
                    <TableHead className="text-center">جديد</TableHead>
                    <TableHead className="text-center">محدّث</TableHead>
                    <TableHead className="text-center">مرفوض</TableHead>
                    <TableHead>المستورد</TableHead>
                    <TableHead>المعتمد</TableHead>
                    <TableHead className="text-center">الحالة</TableHead>
                    <TableHead className="text-center">إجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((batch) => {
                    const expanded = expandedId === batch.id;
                    return (
                      <Fragment key={batch.id}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => toggleExpand(batch.id)}
                        >
                          <TableCell className="text-center">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpand(batch.id);
                              }}
                            >
                              {expanded ? (
                                <ChevronUp className="h-4 w-4" />
                              ) : (
                                <ChevronDown className="h-4 w-4" />
                              )}
                            </Button>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 min-w-0">
                              <FileSpreadsheet className="h-4 w-4 text-emerald-600 shrink-0" />
                              <div className="min-w-0">
                                <p className="font-medium truncate max-w-[200px]">
                                  {batch.fileName}
                                </p>
                                <p className="text-[10px] text-muted-foreground">
                                  {formatFileSize(batch.fileSize)} •{" "}
                                  {formatDate(batch.createdAt)}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1 text-xs">
                              <Calendar className="h-3 w-3 text-muted-foreground" />
                              <div>
                                <p>{formatDate(batch.periodStart)}</p>
                                <p className="text-[10px] text-muted-foreground">
                                  {PERIOD_LABELS[batch.periodType] ||
                                    batch.periodType}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm">
                              {batch.entity || "—"}
                            </span>
                          </TableCell>
                          <TableCell className="text-center">
                            <span className="font-semibold tabular-nums">
                              {formatNumber(batch.totalRecords)}
                            </span>
                          </TableCell>
                          <TableCell className="text-center">
                            <span className="text-emerald-600 font-medium tabular-nums">
                              {formatNumber(batch.newRecords)}
                            </span>
                          </TableCell>
                          <TableCell className="text-center">
                            <span className="text-sky-600 font-medium tabular-nums">
                              {formatNumber(batch.updatedRecords)}
                            </span>
                          </TableCell>
                          <TableCell className="text-center">
                            <span
                              className={`font-medium tabular-nums ${
                                batch.rejectedRecords > 0
                                  ? "text-rose-600"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {formatNumber(batch.rejectedRecords)}
                            </span>
                          </TableCell>
                          <TableCell>
                            <UserChip user={batch.uploadedBy} />
                          </TableCell>
                          <TableCell>
                            {batch.approvedBy ? (
                              <div>
                                <UserChip user={batch.approvedBy} />
                                {batch.approvedAt && (
                                  <p className="text-[10px] text-muted-foreground mt-0.5">
                                    {formatDateTime(batch.approvedAt)}
                                  </p>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-xs">
                                —
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusBadge status={batch.status} />
                          </TableCell>
                          <TableCell className="text-center">
                            <div className="flex items-center justify-center gap-1">
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setDetailsBatch(batch);
                                      }}
                                    >
                                      <Eye className="h-3.5 w-3.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">
                                    عرض التفاصيل
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                              {batch.status === "approved" && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleRollbackClick(batch);
                                        }}
                                      >
                                        <RotateCcw className="h-3.5 w-3.5" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      تراجع عن الاستيراد
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              {batch.canResume && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 gap-1 text-primary"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onResume?.(batch.id);
                                  }}
                                >
                                  <PlayCircle className="h-3.5 w-3.5" />
                                  استكمال الاستيراد
                                </Button>
                              )}
                              {batch.canDelete && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive"
                                  aria-label="حذف ملف الاستيراد غير المعتمد"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setDeleteBatch(batch);
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {expanded && (
                          <TableRow
                            className="bg-transparent hover:bg-transparent"
                          >
                            <TableCell colSpan={12} className="p-0 border-0">
                              <ExpandedDetails batch={batch} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Details Sheet */}
      <Sheet
        open={!!detailsBatch}
        onOpenChange={(o) => !o && setDetailsBatch(null)}
      >
        <SheetContent
          side="left"
          className="sm:max-w-lg w-full overflow-y-auto"
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              تفاصيل الدفعة
            </SheetTitle>
            <SheetDescription>
              {detailsBatch?.fileName}
            </SheetDescription>
          </SheetHeader>

          {detailsBatch && (
            <div className="px-4 pb-6 space-y-4">
              {/* Status + actions */}
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <StatusBadge status={detailsBatch.status} />
                {detailsBatch.status === "approved" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const b = detailsBatch;
                      setDetailsBatch(null);
                      handleRollbackClick(b);
                    }}
                    className="text-amber-600 border-amber-200 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    تراجع عن الاستيراد
                  </Button>
                )}
              </div>

              {/* File info */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">معلومات الملف</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">اسم الملف:</span>
                    <span className="font-medium text-left break-all">
                      {detailsBatch.fileName}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">حجم الملف:</span>
                    <span className="font-medium">
                      {formatFileSize(detailsBatch.fileSize)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">نوع الفترة:</span>
                    <span className="font-medium">
                      {PERIOD_LABELS[detailsBatch.periodType] ||
                        detailsBatch.periodType}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">الفترة:</span>
                    <span className="font-medium">
                      {formatDate(detailsBatch.periodStart)} —{" "}
                      {formatDate(detailsBatch.periodEnd)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">الجهة:</span>
                    <span className="font-medium">
                      {detailsBatch.entity || "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">تاريخ الرفع:</span>
                    <span className="font-medium">
                      {formatDateTime(detailsBatch.createdAt)}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Records breakdown */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">تفصيل السجلات</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-2">
                    <RecordStat
                      label="إجمالي"
                      value={detailsBatch.totalRecords}
                      color="text-foreground"
                    />
                    <RecordStat
                      label="صالحة"
                      value={detailsBatch.validRecords}
                      color="text-emerald-600"
                    />
                    <RecordStat
                      label="جديدة"
                      value={detailsBatch.newRecords}
                      color="text-emerald-600"
                    />
                    <RecordStat
                      label="محدّثة"
                      value={detailsBatch.updatedRecords}
                      color="text-sky-600"
                    />
                    <RecordStat
                      label="مكررة"
                      value={detailsBatch.duplicateRecords}
                      color="text-amber-600"
                    />
                    <RecordStat
                      label="ناقصة"
                      value={detailsBatch.incompleteRecords}
                      color="text-orange-600"
                    />
                    <RecordStat
                      label="مرفوضة"
                      value={detailsBatch.rejectedRecords}
                      color="text-rose-600"
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Users */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    المستخدمون والاعتماد
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-muted-foreground flex items-center gap-1">
                      <User className="h-3.5 w-3.5" />
                      المستورد:
                    </span>
                    <UserChip user={detailsBatch.uploadedBy} />
                  </div>
                  {detailsBatch.approvedBy && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        المعتمد:
                      </span>
                      <UserChip user={detailsBatch.approvedBy} />
                    </div>
                  )}
                  {detailsBatch.approvedAt && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        وقت الاعتماد:
                      </span>
                      <span className="text-sm font-medium">
                        {formatDateTime(detailsBatch.approvedAt)}
                      </span>
                    </div>
                  )}
                  {detailsBatch.rejectionReason && (
                    <div className="rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-800 p-3">
                      <p className="text-xs font-semibold text-rose-700 dark:text-rose-300 mb-1">
                        سبب الرفض
                      </p>
                      <p className="text-xs text-rose-600 dark:text-rose-400">
                        {detailsBatch.rejectionReason}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Errors + mapping */}
              <ExpandedDetails batch={detailsBatch} />
            </div>
          )}
          <SheetClose className="absolute top-4 left-4" />
        </SheetContent>
      </Sheet>

      {/* Rollback confirmation dialog */}
      <AlertDialog
        open={rollbackDialogOpen}
        onOpenChange={(o) => {
          setRollbackDialogOpen(o);
          if (!o) setRollbackBatch(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-amber-600" />
              تأكيد التراجع عن الاستيراد
            </AlertDialogTitle>
            <AlertDialogDescription>
              سيتم التراجع عن الدفعة التالية وحذف جميع السجلات المرتبطة بها:
              <br />
              <br />
              <span className="font-medium text-foreground">الملف: </span>
              {rollbackBatch?.fileName}
              <br />
              <span className="font-medium text-foreground">
                عدد السجلات:{" "}
              </span>
              {rollbackBatch
                ? formatNumber(rollbackBatch.totalRecords)
                : "—"}
              <br />
              <br />
              <span className="text-destructive">
                تحذير: لا يمكن التراجع عن هذه العملية بعد تنفيذها.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollingBack}>
              إلغاء
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmRollback();
              }}
              disabled={rollingBack}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {rollingBack ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              تأكيد التراجع
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(deleteBatch)} onOpenChange={(open) => !open && setDeleteBatch(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>هل تريد حذف ملف الاستيراد غير المعتمد؟</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">سيتم حذف الملف المرفوع ونتائج المعاينة والصفوف المرتبطة به، ولا يمكن التراجع عن هذا الإجراء.</span>
              <span className="block font-medium text-foreground">اسم الملف: {deleteBatch?.fileName}</span>
              <span className="block">تاريخ الرفع: {deleteBatch ? formatDateTime(deleteBatch.createdAt) : "—"}</span>
              <span className="block">عدد الصفوف: {formatNumber(deleteBatch?.totalRecords ?? 0)}</span>
              <span className="block">الحالة: {deleteBatch ? getStatusMeta(deleteBatch.status).label : "—"}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>إلغاء</AlertDialogCancel>
            <AlertDialogAction disabled={deleting} onClick={(event) => { event.preventDefault(); void confirmDelete(); }}>
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              حذف الملف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------- Record Stat sub-component ----------
function RecordStat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="rounded-md border bg-background p-2 text-center">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${color}`}>
        {formatNumber(value)}
      </p>
    </div>
  );
}
