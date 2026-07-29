"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Download,
  FileWarning,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Loader2,
  Database,
  CalendarDays,
  Layers,
  ClipboardCheck,
  ClipboardX,
} from "lucide-react";
import { formatNumber, formatDate } from "@/lib/ar-utils";

// ===== Types =====

export type PeriodType = "daily" | "weekly" | "monthly" | "custom";

interface ImportError {
  row: number;
  complaintNumber?: string;
  errors: Array<{ message: string }>;
  warnings: Array<{ message: string }>;
}

interface ImportPreviewRow {
  row: number;
  complaintNumber?: string;
  receivedDate?: string;
  channel?: string;
  region?: string;
  location?: string;
  department?: string;
  classification?: string;
  subject?: string;
  status?: string;
  priority?: string;
  severity?: string;
  [key: string]: any;
}

interface UploadResult {
  batchId: string;
  fileName: string;
  totalRecords: number;
  validRecords: number;
  newRecords: number;
  updatedRecords: number;
  duplicateRecords: number;
  rejectedRecords: number;
  incompleteRecords: number;
  warningRecords: number;
  noChangeRecords: number;
  selectedSheet: string | null;
  hasComplaintNumber: boolean;
  unmappedColumns: string[];
  columnMapping: Record<string, string>;
  errors: ImportError[];
  preview: ImportPreviewRow[];
  canApprove: boolean;
}

// Workflow stages
const STAGES = [
  { key: "upload", label: "رفع الملف", icon: Upload },
  { key: "validate", label: "التحقق", icon: ClipboardCheck },
  { key: "preview", label: "المعاينة", icon: FileSpreadsheet },
  { key: "errors", label: "معالجة الأخطاء", icon: AlertTriangle },
  { key: "approve", label: "جاهز للتأكيد", icon: CheckCircle2 },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

// Field display names (English field -> Arabic label)
const FIELD_LABELS: Record<string, string> = {
  complaintNumber: "رقم الشكوى",
  receivedDate: "تاريخ الورود",
  channel: "القناة",
  region: "المنطقة",
  location: "الموقع",
  department: "الإدارة",
  classification: "التصنيف",
  subClassification: "التصنيف الفرعي",
  subject: "الموضوع",
  description: "الوصف",
  status: "الحالة",
  priority: "الأولوية",
  severity: "الخطورة",
  referralDate: "تاريخ الإحالة",
  firstActionDate: "أول إجراء",
  processingDate: "تاريخ المعالجة",
  closureDate: "تاريخ الإغلاق",
  dueDate: "المهلة",
  resolution: "النتيجة",
  delayReason: "سبب التأخر",
  isRepeated: "متكررة",
  isValidated: "صحة الشكوى",
  satisfaction: "رضا المستفيد",
};

// Stat card config
const STAT_CARDS = [
  {
    key: "total",
    label: "إجمالي السجلات",
    icon: Database,
    color: "text-slate-700 dark:text-slate-300",
    bg: "bg-slate-50 dark:bg-slate-900/40",
    ring: "ring-slate-200 dark:ring-slate-800",
    get: (r: UploadResult) => r.totalRecords,
  },
  {
    key: "valid",
    label: "سجلات صالحة",
    icon: CheckCircle2,
    color: "text-emerald-700 dark:text-emerald-300",
    bg: "bg-emerald-50 dark:bg-emerald-900/30",
    ring: "ring-emerald-200 dark:ring-emerald-800",
    get: (r: UploadResult) => r.validRecords,
  },
  {
    key: "new",
    label: "سجلات جديدة",
    icon: Layers,
    color: "text-emerald-700 dark:text-emerald-300",
    bg: "bg-emerald-50 dark:bg-emerald-900/30",
    ring: "ring-emerald-200 dark:ring-emerald-800",
    get: (r: UploadResult) => r.newRecords,
  },
  {
    key: "updated",
    label: "تحديثات",
    icon: RefreshCw,
    color: "text-teal-700 dark:text-teal-300",
    bg: "bg-teal-50 dark:bg-teal-900/30",
    ring: "ring-teal-200 dark:ring-teal-800",
    get: (r: UploadResult) => r.updatedRecords,
  },
  {
    key: "duplicate",
    label: "مكررة",
    icon: AlertTriangle,
    color: "text-amber-700 dark:text-amber-300",
    bg: "bg-amber-50 dark:bg-amber-900/30",
    ring: "ring-amber-200 dark:ring-amber-800",
    get: (r: UploadResult) => r.duplicateRecords,
  },
  {
    key: "rejected",
    label: "مرفوضة",
    icon: XCircle,
    color: "text-rose-700 dark:text-rose-300",
    bg: "bg-rose-50 dark:bg-rose-900/30",
    ring: "ring-rose-200 dark:ring-rose-800",
    get: (r: UploadResult) => r.rejectedRecords,
  },
  {
    key: "incomplete",
    label: "ناقصة",
    icon: FileWarning,
    color: "text-orange-700 dark:text-orange-300",
    bg: "bg-orange-50 dark:bg-orange-900/30",
    ring: "ring-orange-200 dark:ring-orange-800",
    get: (r: UploadResult) => r.incompleteRecords,
  },
];

// ===== Component =====

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function subtractOneCalendarMonth(date: Date): Date {
  const targetMonth = date.getMonth() - 1;
  const targetYear = date.getFullYear() + Math.floor(targetMonth / 12);
  const normalizedTargetMonth = (targetMonth + 12) % 12;
  const targetDay = Math.min(
    date.getDate(),
    daysInMonth(targetYear, normalizedTargetMonth)
  );

  return new Date(
    targetYear,
    normalizedTargetMonth,
    targetDay,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

export function defaultPeriodRange(periodType: PeriodType, today = new Date()) {
  const end = formatLocalDate(today);
  const startDate = new Date(today);

  if (periodType === "weekly") {
    startDate.setDate(startDate.getDate() - 6);
  } else if (periodType === "monthly") {
    const previousMonthDate = subtractOneCalendarMonth(today);
    startDate.setTime(previousMonthDate.getTime());
    startDate.setDate(startDate.getDate() + 1);
  }

  return { start: formatLocalDate(startDate), end };
}

export function ImportCenter() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialPeriod = useMemo(() => defaultPeriodRange("daily"), []);

  // Form state
  const [file, setFile] = useState<File | null>(null);
  const [periodType, setPeriodType] = useState<PeriodType>("daily");
  const [periodStart, setPeriodStart] = useState<string>(initialPeriod.start);
  const [periodEnd, setPeriodEnd] = useState<string>(initialPeriod.end);
  const [dragOver, setDragOver] = useState(false);

  // Submission/approval state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePeriodTypeChange = (value: PeriodType) => {
    setPeriodType(value);
    if (value !== "custom") {
      const range = defaultPeriodRange(value);
      setPeriodStart(range.start);
      setPeriodEnd(range.end);
    }
  };

  // Compute current stage
  const currentStage: StageKey = useMemo(() => {
    if (result) {
      if (result.errors.length > 0) return "errors";
      return "approve";
    }
    if (uploading) return "validate";
    return "upload";
  }, [uploading, result]);

  const stageIndex = STAGES.findIndex((s) => s.key === currentStage);

  // Handlers
  const handleFileSelect = useCallback((f: File | null) => {
    if (!f) return;
    const isExcel = f.name.toLowerCase().endsWith(".xlsx");
    if (!isExcel) {
      toast({
        variant: "destructive",
        title: "نوع ملف غير مدعوم",
        description: "الرجاء اختيار ملف Excel بصيغة .xlsx فقط",
      });
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      toast({
        variant: "destructive",
        title: "حجم الملف كبير",
        description: "الحد الأقصى لحجم الملف هو 10 ميجابايت",
      });
      return;
    }
    setFile(f);
    setResult(null);
    setError(null);
  }, [toast]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFileSelect(f);
  }, [handleFileSelect]);

  const handleUpload = async () => {
    if (!file) {
      toast({
        variant: "destructive",
        title: "لم يتم اختيار ملف",
        description: "الرجاء اختيار ملف Excel للمتابعة",
      });
      return;
    }
    if (!periodStart || !periodEnd) {
      toast({
        variant: "destructive",
        title: "الفترة الزمنية غير محددة",
        description: "الرجاء تحديد تاريخ بداية ونهاية الفترة",
      });
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setError(null);
    setResult(null);

    // simulate progress while uploading
    const timer = setInterval(() => {
      setUploadProgress((p) => (p >= 90 ? p : p + 5));
    }, 200);

    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("periodType", periodType);
      fd.append("periodStart", periodStart);
      fd.append("periodEnd", periodEnd);

      const res = await fetch("/api/import/upload", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "فشل في رفع الملف");
      }
      setResult({
        ...json,
        hasComplaintNumber: Boolean(json.columnMapping?.["رقم الشكوى"]),
        unmappedColumns: [],
      });
      setUploadProgress(100);
      toast({
        title: "تمت معالجة الملف بنجاح",
        description: `تم تحليل ${formatNumber(json.totalRecords)} سجل وأصبحت الدفعة جاهزة للتأكيد في الجولة التالية`,
      });
    } catch (err: any) {
      setError(err.message || "حدث خطأ غير متوقع");
      toast({
        variant: "destructive",
        title: "فشل في الاستيراد",
        description: err.message || "حدث خطأ غير متوقع",
      });
    } finally {
      clearInterval(timer);
      setUploading(false);
    }
  };

  const resetForm = () => {
    setFile(null);
    setResult(null);
    setError(null);
    setUploadProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const downloadErrorReport = () => {
    if (!result) return;
    window.location.href = `/api/import/${result.batchId}/errors`;
  };

  const downloadCsvTemplate = () => {
    const headers = Object.keys(FIELD_LABELS).slice(0, 12);
    const headerLabels = headers.map((h) => FIELD_LABELS[h]);
    const csv = "\uFEFF" + headerLabels.join(",") + "\n" +
      headers.map(() => "").join(",") + "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "قالب-استيراد-الشكاوى.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({
      title: "تم تنزيل القالب",
      description: "استخدم القالب كمرجع لترتيب الأعمدة قبل الاستيراد",
    });
  };

  // ===== Render =====
  return (
    <div className="space-y-6">
      <PageHeader
        title="مركز الاستيراد"
        description="رفع ملفات الشكاوى والتحقق منها ومعاينة نتائجها قبل التأكيد"
        icon={<Upload className="h-6 w-6" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={downloadCsvTemplate}>
              <Download className="h-4 w-4" />
              تنزيل قالب
            </Button>
            {(result || file) && (
              <Button variant="outline" size="sm" onClick={resetForm}>
                <RefreshCw className="h-4 w-4" />
                إعادة تعيين
              </Button>
            )}
          </>
        }
      />

      {/* Workflow Stepper */}
      <Card className="overflow-hidden border-emerald-100 dark:border-emerald-900/40">
        <CardContent className="p-4 md:p-6">
          <div className="flex items-center justify-between gap-1 overflow-x-auto pb-2">
            {STAGES.map((stage, idx) => {
              const isDone = idx < stageIndex;
              const isCurrent = idx === stageIndex;
              const Icon = stage.icon;
              return (
                <div
                  key={stage.key}
                  className="flex items-center gap-1 flex-shrink-0"
                >
                  <div className="flex flex-col items-center gap-2 min-w-[90px]">
                    <div
                      className={[
                        "flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all",
                        isDone
                          ? "bg-emerald-500 border-emerald-500 text-white"
                          : isCurrent
                          ? "bg-emerald-50 dark:bg-emerald-900/30 border-emerald-500 text-emerald-600 dark:text-emerald-300 ring-4 ring-emerald-100 dark:ring-emerald-900/30"
                          : "bg-muted border-border text-muted-foreground",
                      ].join(" ")}
                    >
                      {isDone ? (
                        <CheckCircle2 className="h-5 w-5" />
                      ) : isCurrent && uploading ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                      ) : (
                        <Icon className="h-5 w-5" />
                      )}
                    </div>
                    <span
                      className={[
                        "text-xs font-medium text-center leading-tight",
                        isCurrent
                          ? "text-emerald-700 dark:text-emerald-300"
                          : isDone
                          ? "text-foreground"
                          : "text-muted-foreground",
                      ].join(" ")}
                    >
                      {stage.label}
                    </span>
                  </div>
                  {idx < STAGES.length - 1 && (
                    <div
                      className={[
                        "h-0.5 w-8 md:w-16 transition-colors",
                        isDone ? "bg-emerald-500" : "bg-border",
                      ].join(" ")}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Main content */}
      {(
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Upload form */}
          <div className="lg:col-span-1 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
                  بيانات الملف والفترة
                </CardTitle>
                <CardDescription>
                  حدد نوع الفترة والكيان المشمول قبل رفع الملف
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* File upload area */}
                <div className="space-y-2">
                  <Label>ملف الشكاوى (Excel)</Label>
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={[
                      "relative cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-all",
                      dragOver
                        ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20"
                        : file
                        ? "border-emerald-300 bg-emerald-50/50 dark:bg-emerald-900/10 dark:border-emerald-800"
                        : "border-muted-foreground/30 hover:border-emerald-400 hover:bg-muted/50",
                    ].join(" ")}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".xlsx"
                      className="sr-only"
                      onChange={(e) =>
                        handleFileSelect(e.target.files?.[0] || null)
                      }
                    />
                    {file ? (
                      <div className="flex flex-col items-center gap-2">
                        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                          <FileSpreadsheet className="h-6 w-6 text-emerald-600" />
                        </div>
                        <div className="text-sm font-medium text-foreground break-all max-w-full">
                          {file.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {(file.size / 1024).toFixed(1)} كيلوبايت
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFile(null);
                            if (fileInputRef.current)
                              fileInputRef.current.value = "";
                          }}
                        >
                          <XCircle className="h-4 w-4" />
                          إزالة
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
                          <Upload className="h-6 w-6 text-muted-foreground" />
                        </div>
                        <div className="text-sm font-medium">
                          اسحب الملف هنا أو اضغط للاختيار
                        </div>
                        <div className="text-xs text-muted-foreground">
                          الصيغة المدعومة: XLSX (الحد الأقصى 10MB)
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Period type */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                    نوع الفترة
                  </Label>
                  <Select
                    value={periodType}
                    onValueChange={(v) => handlePeriodTypeChange(v as PeriodType)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">يومي</SelectItem>
                      <SelectItem value="weekly">أسبوعي</SelectItem>
                      <SelectItem value="monthly">شهري</SelectItem>
                      <SelectItem value="custom">مخصص</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Dates */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label className="text-xs">من تاريخ</Label>
                    <Input
                      type="date"
                      value={periodStart}
                      onChange={(e) => setPeriodStart(e.target.value)}
                      className="w-full"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">إلى تاريخ</Label>
                    <Input
                      type="date"
                      value={periodEnd}
                      onChange={(e) => setPeriodEnd(e.target.value)}
                      className="w-full"
                    />
                  </div>
                </div>

                <Button
                  className="w-full"
                  size="lg"
                  onClick={handleUpload}
                  disabled={!file || uploading}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      جارٍ المعالجة...
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4" />
                      رفع وتحليل الملف
                    </>
                  )}
                </Button>

                {uploading && (
                  <div className="space-y-1">
                    <Progress value={uploadProgress} className="h-2" />
                    <p className="text-xs text-center text-muted-foreground">
                      {uploadProgress < 100
                        ? "جارٍ قراءة الملف والتحقق من البيانات..."
                        : "اكتمل التحليل"}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Validation tips */}
            <Card className="bg-muted/30 border-dashed">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  إرشادات الاستيراد
                </div>
                <ul className="text-xs text-muted-foreground space-y-1.5 list-disc pr-4">
                  <li>يجب أن يحتوي الملف على عمود &quot;رقم الشكوى&quot;</li>
                  <li>الحد الأدنى: معرف أو رقم مرجعي، تاريخ، موضوع أو وصف</li>
                  <li>لا يتم إنشاء أو تحديث الشكاوى في هذه الجولة</li>
                  <li>تتم مطابقة الشكاوى الموجودة بسياسة الهوية المركزية</li>
                  <li>تسجل الصفوف المكررة داخل الملف ولا تُحذف</li>
                </ul>
              </CardContent>
            </Card>
          </div>

          {/* Right: Results area */}
          <div className="lg:col-span-2 space-y-6">
            {error && (
              <Alert variant="destructive">
                <XCircle className="h-4 w-4" />
                <AlertTitle>فشل في الاستيراد</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {!result && !uploading && !error && (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-20 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
                    <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-medium mb-1">
                    في انتظار رفع الملف
                  </h3>
                  <p className="text-sm text-muted-foreground max-w-md">
                    اختر ملف الشكاوى من اللوحة الجانبية وحدد الفترة الزمنية ثم
                    اضغط &quot;رفع وتحليل الملف&quot; لبدء عملية التحقق والمعاينة.
                  </p>
                </CardContent>
              </Card>
            )}

            {uploading && !result && (
              <Card>
                <CardContent className="py-12">
                  <div className="space-y-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-4">
                        <Skeleton className="h-12 w-12 rounded-lg" />
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-4 w-3/4" />
                          <Skeleton className="h-3 w-1/2" />
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {result && (
              <>
                {/* Stat cards grid */}
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                  {STAT_CARDS.map((card) => {
                    const value = card.get(result);
                    const Icon = card.icon;
                    return (
                      <Card
                        key={card.key}
                        className={`ring-1 ${card.ring} ${card.bg} border-0`}
                      >
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between mb-2">
                            <div
                              className={`flex h-8 w-8 items-center justify-center rounded-md bg-white/60 dark:bg-black/20 ${card.color}`}
                            >
                              <Icon className="h-4 w-4" />
                            </div>
                          </div>
                          <div
                            className={`text-2xl font-bold ${card.color}`}
                          >
                            {formatNumber(value)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {card.label}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>

                {/* Ready status banner */}
                {result.errors.length > 0 ? (
                  <Alert className="border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900/50 text-amber-900 dark:text-amber-200">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <AlertTitle>توجد أخطاء تحتاج معالجة</AlertTitle>
                    <AlertDescription className="text-amber-800 dark:text-amber-300">
                      يوجد {formatNumber(result.errors.length)} صفًا يحتوي أخطاء أو تحذيرات. لم يتم إنشاء أو تحديث أي شكوى.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Alert className="border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-900/50 text-emerald-900 dark:text-emerald-200">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    <AlertTitle>الدفعة جاهزة للتأكيد</AlertTitle>
                    <AlertDescription className="text-emerald-800 dark:text-emerald-300">
                      تم حفظ المعاينة وحالة الدفعة هي READY_FOR_CONFIRMATION. تنفيذ التأكيد سيتم في الجولة التالية.
                    </AlertDescription>
                  </Alert>
                )}

                {/* Detailed tabs */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <CardTitle className="text-base flex items-center gap-2">
                          <ClipboardCheck className="h-5 w-5 text-emerald-600" />
                          نتائج التحليل والمعاينة
                        </CardTitle>
                        <CardDescription className="mt-1">
                          اسم الملف:{" "}
                          <span className="font-medium text-foreground">
                            {result.fileName}
                          </span>{" "}
                          • معرّف الدفعة:{" "}
                          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                            {result.batchId.slice(-8)}
                          </code>
                        </CardDescription>
                      </div>
                      {result.errors.length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={downloadErrorReport}
                        >
                          <Download className="h-4 w-4" />
                          تنزيل تقرير الأخطاء
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Tabs defaultValue="mapping" className="w-full">
                      <TabsList className="w-full justify-start flex-wrap h-auto p-1">
                        <TabsTrigger value="mapping">
                          <Layers className="h-4 w-4" />
                          تعيين الأعمدة
                          {result.unmappedColumns.length > 0 && (
                            <Badge
                              variant="destructive"
                              className="mr-1 h-5 px-1.5 text-[10px]"
                            >
                              {result.unmappedColumns.length}
                            </Badge>
                          )}
                        </TabsTrigger>
                        <TabsTrigger value="preview">
                          <FileSpreadsheet className="h-4 w-4" />
                          معاينة السجلات
                          <Badge
                            variant="secondary"
                            className="mr-1 h-5 px-1.5 text-[10px]"
                          >
                            {formatNumber(result.preview.length)}
                          </Badge>
                        </TabsTrigger>
                        <TabsTrigger value="errors">
                          <AlertTriangle className="h-4 w-4" />
                          الأخطاء
                          <Badge
                            variant={
                              result.errors.length > 0
                                ? "destructive"
                                : "secondary"
                            }
                            className="mr-1 h-5 px-1.5 text-[10px]"
                          >
                            {formatNumber(result.errors.length)}
                          </Badge>
                        </TabsTrigger>
                      </TabsList>

                      {/* Mapping tab */}
                      <TabsContent value="mapping" className="mt-4">
                        {result.unmappedColumns.length > 0 && (
                          <Alert className="mb-3 border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900/50">
                            <FileWarning className="h-4 w-4 text-amber-600" />
                            <AlertTitle>أعمدة غير معيّنة</AlertTitle>
                            <AlertDescription className="text-amber-800 dark:text-amber-300">
                              لم يتم التعرف التلقائي على{" "}
                              {formatNumber(result.unmappedColumns.length)}{" "}
                              عمود. يرجى مراجعة التسميات أو إعادة تسمية الأعمدة
                              في الملف الأصلي.
                            </AlertDescription>
                          </Alert>
                        )}
                        <div className="rounded-lg border overflow-hidden">
                          <Table>
                            <TableHeader>
                              <TableRow className="bg-muted/50">
                                <TableHead className="w-1/2">
                                  العمود في الملف
                                </TableHead>
                                <TableHead className="w-1/2">
                                  الحقل المعتمد
                                </TableHead>
                                <TableHead className="w-24 text-center">
                                  الحالة
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {Object.entries(result.columnMapping).map(
                                ([src, target]) => {
                                  const unmapped =
                                    result.unmappedColumns.includes(src);
                                  return (
                                    <TableRow
                                      key={src}
                                      className={
                                        unmapped
                                          ? "bg-amber-50/50 dark:bg-amber-950/20"
                                          : ""
                                      }
                                    >
                                      <TableCell className="font-medium">
                                        {src}
                                      </TableCell>
                                      <TableCell>
                                        {unmapped ? (
                                          <span className="text-amber-600 dark:text-amber-400 text-sm">
                                            غير معيّن
                                          </span>
                                        ) : (
                                          <div className="flex items-center gap-1.5">
                                            <ArrowLeft className="h-3 w-3 text-muted-foreground" />
                                            <Badge
                                              variant="outline"
                                              className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800"
                                            >
                                              {FIELD_LABELS[target] || target}
                                            </Badge>
                                          </div>
                                        )}
                                      </TableCell>
                                      <TableCell className="text-center">
                                        {unmapped ? (
                                          <XCircle className="h-4 w-4 text-amber-500 mx-auto" />
                                        ) : (
                                          <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" />
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  );
                                }
                              )}
                            </TableBody>
                          </Table>
                        </div>
                      </TabsContent>

                      {/* Preview tab */}
                      <TabsContent value="preview" className="mt-4">
                        {result.preview.length === 0 ? (
                          <div className="text-center py-10 text-sm text-muted-foreground">
                            لا توجد سجلات صالحة للمعاينة
                          </div>
                        ) : (
                          <div className="rounded-lg border overflow-hidden max-h-[460px] overflow-y-auto">
                            <Table>
                              <TableHeader className="sticky top-0 z-10 bg-card">
                                <TableRow>
                                  <TableHead className="w-12">#</TableHead>
                                  <TableHead>رقم الشكوى</TableHead>
                                  <TableHead>التاريخ</TableHead>
                                  <TableHead>القناة</TableHead>
                                  <TableHead>الموضوع</TableHead>
                                  <TableHead>الحالة</TableHead>
                                  <TableHead>الأولوية</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {result.preview.map((row, idx) => (
                                  <TableRow key={idx}>
                                    <TableCell className="text-muted-foreground text-xs">
                                      {row.row}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                      {row.complaintNumber || "-"}
                                    </TableCell>
                                    <TableCell className="text-xs">
                                      {row.receivedDate
                                        ? formatDate(row.receivedDate)
                                        : "-"}
                                    </TableCell>
                                    <TableCell className="text-xs">
                                      {row.channel || "-"}
                                    </TableCell>
                                    <TableCell className="max-w-[240px] truncate text-xs">
                                      {row.subject || "-"}
                                    </TableCell>
                                    <TableCell>
                                      <Badge
                                        variant="outline"
                                        className="text-[10px]"
                                      >
                                        {row.status || "-"}
                                      </Badge>
                                    </TableCell>
                                    <TableCell>
                                      <Badge
                                        variant="outline"
                                        className="text-[10px]"
                                      >
                                        {row.priority || "-"}
                                      </Badge>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground mt-2 text-center">
                          عرض أول {formatNumber(result.preview.length)} سجلات
                          صالحة من إجمالي {formatNumber(result.validRecords)}
                        </p>
                      </TabsContent>

                      {/* Errors tab */}
                      <TabsContent value="errors" className="mt-4">
                        {result.errors.length === 0 ? (
                          <div className="flex flex-col items-center py-10 text-center">
                            <CheckCircle2 className="h-12 w-12 text-emerald-500 mb-3" />
                            <p className="text-sm font-medium">
                              لا توجد أخطاء — جميع السجلات صالحة
                            </p>
                          </div>
                        ) : (
                          <div className="rounded-lg border overflow-hidden max-h-[460px] overflow-y-auto">
                            <Table>
                              <TableHeader className="sticky top-0 z-10 bg-card">
                                <TableRow>
                                  <TableHead className="w-16">الصف</TableHead>
                                  <TableHead className="w-40">
                                    رقم الشكوى
                                  </TableHead>
                                  <TableHead>رسائل الخطأ</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {result.errors.map((err, idx) => (
                                  <TableRow key={idx}>
                                    <TableCell className="font-mono text-xs text-rose-600 dark:text-rose-400">
                                      {err.row}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                      {err.complaintNumber}
                                    </TableCell>
                                    <TableCell>
                                      <ul className="flex flex-wrap gap-1.5">
                                        {err.errors.map((msg, mi) => (
                                          <li key={mi}>
                                            <Badge
                                              variant="outline"
                                              className="bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-900 text-[11px] font-normal"
                                            >
                                              <XCircle className="h-3 w-3" />
                                              {msg.message}
                                            </Badge>
                                          </li>
                                        ))}
                                      </ul>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        )}
                        {result.errors.length >= 50 && (
                          <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 text-center">
                            يتم عرض أول 50 خطأ — نزّل التقرير الكامل للاطلاع على
                            جميع الأخطاء
                          </p>
                        )}
                      </TabsContent>
                    </Tabs>
                  </CardContent>
                </Card>

                {/* Action footer */}
                <Card className="border-emerald-100 dark:border-emerald-900/40 bg-emerald-50/50 dark:bg-emerald-950/20">
                  <CardContent className="p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                      <span className="font-medium">
                        الدفعة محفوظة للمعاينة
                      </span>
                      <span className="text-muted-foreground hidden sm:inline">
                        • {formatNumber(result.validRecords)} صف صالح، ولا توجد تغييرات مطبقة على الشكاوى
                      </span>
                    </div>
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                      <Button
                        variant="outline"
                        className="flex-1 sm:flex-none"
                        onClick={resetForm}
                      >
                        <ClipboardX className="h-4 w-4" />
                        رفع ملف آخر
                      </Button>
                      <Button
                        className="flex-1 sm:flex-none"
                        disabled
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        التأكيد في الجولة التالية
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      {/* Helper footer note */}
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground pt-2">
        <ArrowRight className="h-3 w-3" />
        <span>
          يتم تخزين جميع عمليات الاستيراد والاعتماد في سجل التدقيق لضمان قابلية
          التتبع
        </span>
      </div>
    </div>
  );
}
