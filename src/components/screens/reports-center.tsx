"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  FileText, FileSpreadsheet, FileSearch, Download, Save, Calendar,
  Plus, Building2, MapPin, Layers, RefreshCw, History, Eye, XCircle,
  AlertTriangle, Loader2, CalendarClock, PlayCircle,
} from "lucide-react";
import { formatNumber, formatDate, formatDateTime } from "@/lib/ar-utils";

// =========================================================================
// Types (mirrors src/server/reports/*)
// =========================================================================

type ReportType =
  | "EXECUTIVE_SUMMARY"
  | "DEPARTMENT_PERFORMANCE"
  | "REGION_FACILITY_PERFORMANCE"
  | "CLASSIFICATION_ANALYSIS"
  | "COMPLAINT_DETAIL"
  | "OVERDUE_COMPLAINTS";

type ReportDefinition = {
  type: ReportType;
  title: string;
  description: string;
  supportedFilters: string[];
  sections: string[];
  defaultColumns: string[];
  maxRows: number;
  supportsPdf: boolean;
  supportsXlsx: boolean;
  requiresPeriod: boolean;
};

type FiltersData = {
  regions: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  facilities: { id: string; name: string; regionId: string | null }[];
  classifications: { id: string; name: string; children: { id: string; name: string }[] }[];
  channels: string[];
};

type ReportKpiCard = { key: string; label: string; value: number; format: "number" | "percent" | "days" | "hours" };
type ReportTableColumn = { key: string; label: string; format?: "number" | "percent" | "date" | "text" };
type ReportTable = {
  id: string; title: string; columns: ReportTableColumn[];
  rows: Record<string, unknown>[]; truncated: boolean; totalMatched: number;
};
type ChartSeries = { name: string; points: { x: string; y: number }[]; isOther?: boolean };
type ReportSection =
  | { id: string; kind: "kpi"; title: string; cards: ReportKpiCard[] }
  | { id: string; kind: "table"; title: string; table: ReportTable }
  | { id: string; kind: "text"; title: string; points: string[] }
  | { id: string; kind: "chart"; chartType: "line"; title: string; series: ChartSeries[]; description?: string; emptyState?: string; unit?: string; truncated?: boolean; truncatedMessage?: string };

type ReportData = {
  type: ReportType;
  title: string;
  generatedAt: string;
  period: { from: string; to: string };
  filters: Record<string, unknown>;
  sections: ReportSection[];
  warnings: string[];
  rowCount: number;
};

type ReportTemplate = {
  id: string;
  name: string;
  description: string | null;
  reportType: ReportType;
  isActive: boolean;
  lastRunAt: string | null;
  createdAt: string;
  schedules: ReportSchedule[];
};

type ReportSchedule = {
  id: string;
  reportTemplateId: string;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY";
  timeOfDay: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  isEnabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  reportTemplate?: { id: string; name: string; reportType: ReportType; isActive: boolean };
};

type ReportRunRow = {
  id: string;
  reportType: ReportType;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  requestedBy: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  reportTemplate?: { id: string; name: string } | null;
  artifacts: { id: string; format: "PDF" | "XLSX"; fileName: string; fileSize: number }[];
};

type FiltersForm = {
  from: string;
  to: string;
  region: string;
  department: string;
  facility: string;
  classificationId: string;
  priority: string;
  severity: string;
  channel: string;
  status: string;
};

type ReportFilterKey = Exclude<keyof FiltersForm, "from" | "to">;
const FILTER_KEYS: ReportFilterKey[] = [
  "region", "department", "facility", "classificationId", "priority", "severity", "channel", "status",
];

type OptionsForm = {
  includeComparison: boolean;
  includeCharts: boolean;
  includeDetailedRows: boolean;
};

type InitialData = { definitions: ReportDefinition[]; filtersData: FiltersData };

const REPORT_ICONS: Record<ReportType, typeof FileText> = {
  EXECUTIVE_SUMMARY: FileText,
  DEPARTMENT_PERFORMANCE: Building2,
  REGION_FACILITY_PERFORMANCE: MapPin,
  CLASSIFICATION_ANALYSIS: Layers,
  COMPLAINT_DETAIL: FileSearch,
  OVERDUE_COMPLAINTS: AlertTriangle,
};

const REPORT_COLORS: Record<ReportType, string> = {
  EXECUTIVE_SUMMARY: "from-emerald-500 to-teal-600",
  DEPARTMENT_PERFORMANCE: "from-violet-500 to-purple-600",
  REGION_FACILITY_PERFORMANCE: "from-sky-500 to-cyan-600",
  CLASSIFICATION_ANALYSIS: "from-amber-500 to-orange-600",
  COMPLAINT_DETAIL: "from-slate-500 to-zinc-600",
  OVERDUE_COMPLAINTS: "from-rose-500 to-pink-600",
};

const STATUS_LABELS_AR: Record<string, string> = {
  NEW: "جديدة", OPEN: "مفتوحة", IN_PROGRESS: "قيد المعالجة", AWAITING_RESPONSE: "بانتظار الرد",
  RESOLVED: "محلولة", CLOSED: "مغلقة", CANCELLED: "ملغاة",
};
const PRIORITY_LABELS_AR: Record<string, string> = {
  LOW: "منخفضة", MEDIUM: "متوسطة", HIGH: "عالية", CRITICAL: "حرجة",
};
const RUN_STATUS_LABELS: Record<string, string> = {
  PENDING: "قيد الانتظار", RUNNING: "قيد التنفيذ", COMPLETED: "مكتمل", FAILED: "فشل",
};

function runStatusBadgeVariant(status: ReportRunRow["status"]): "secondary" | "destructive" | "outline" {
  if (status === "COMPLETED") return "secondary";
  if (status === "FAILED") return "destructive";
  return "outline";
}
const FREQUENCY_LABELS: Record<string, string> = { DAILY: "يومي", WEEKLY: "أسبوعي", MONTHLY: "شهري" };
const WEEKDAY_LABELS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

const KPI_FORMAT_SUFFIX: Record<ReportKpiCard["format"], string> = {
  number: "", percent: "%", days: " يوم", hours: " ساعة",
};

function formatKpiValue(card: ReportKpiCard): string {
  return `${formatNumber(card.value)}${KPI_FORMAT_SUFFIX[card.format]}`;
}

function toDisplayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function formatCell(value: unknown, format?: ReportTableColumn["format"]): string {
  if (value === null || value === undefined || value === "") return "—";
  if (format === "percent") return `${toDisplayText(value)}%`;
  if (format === "date") {
    const date = new Date(toDisplayText(value));
    return Number.isNaN(date.getTime()) ? "—" : formatDate(date);
  }
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (format === "number" && typeof value === "number") return formatNumber(value);
  return toDisplayText(value);
}

function toLocalDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultFilters(): FiltersForm {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    from: toLocalDateString(from), to: toLocalDateString(to), region: "all", department: "all", facility: "all",
    classificationId: "all", priority: "all", severity: "all", channel: "all", status: "all",
  };
}

function supportsFilter(definition: ReportDefinition | null, filter: ReportFilterKey): boolean {
  return Boolean(definition?.supportedFilters.includes(filter));
}

function requiresReportPeriod(definition: ReportDefinition | null): boolean {
  return definition?.requiresPeriod === true;
}

/** Only the filters the selected report type actually supports are ever sent
 * — an unsupported field is dropped even if it holds a non-"all" value in
 * local form state, and from/to are omitted entirely when the report type
 * doesn't require a period. */
function buildSupportedFiltersPayload(filters: FiltersForm, definition: ReportDefinition): Record<string, string> {
  const payload: Record<string, string> = {};
  if (requiresReportPeriod(definition)) {
    payload.from = filters.from;
    payload.to = filters.to;
  }
  for (const key of FILTER_KEYS) {
    if (supportsFilter(definition, key) && filters[key] !== "all") {
      payload[key] = filters[key];
    }
  }
  return payload;
}

/** Called when switching report types: clears any filter value the newly
 * selected type doesn't support, and clears/restores the period fields
 * depending on whether the new type requires one, so a stale hidden filter
 * from the previous type can never reach the request payload. */
function resetUnsupportedFilters(current: FiltersForm, definition: ReportDefinition): FiltersForm {
  const next = { ...current };
  if (!requiresReportPeriod(definition)) {
    next.from = "";
    next.to = "";
  } else if (!next.from || !next.to) {
    const defaults = defaultFilters();
    next.from = next.from || defaults.from;
    next.to = next.to || defaults.to;
  }
  for (const key of FILTER_KEYS) {
    if (!supportsFilter(definition, key)) {
      next[key] = "all";
    }
  }
  return next;
}

function validatePeriod(definition: ReportDefinition, filtersForm: FiltersForm): string | null {
  if (!requiresReportPeriod(definition)) return null;
  if (!filtersForm.from || !filtersForm.to) return "يجب تحديد الفترة الزمنية لهذا التقرير";
  if (filtersForm.from > filtersForm.to) return "يجب أن يكون تاريخ البداية قبل أو يساوي تاريخ النهاية";
  return null;
}

// =========================================================================
// Fetch helpers: never collapse a non-ok response into an empty/null value
// =========================================================================

class ReportApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ReportApiError";
    this.status = status;
    this.code = code;
  }
}

async function parseJsonSafe(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

async function fetchReportJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await parseJsonSafe(response);

  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? "تعذر تحميل بيانات التقارير";
    throw new ReportApiError(message, response.status, body?.error?.code);
  }

  return body as T;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// =========================================================================
// Resource loading state: distinguishes loading / error / empty / populated
// without nested ternaries at the render call site.
// =========================================================================

type ResourceState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

function ResourceSection<T>({
  state, emptyIcon, emptyText, onRetry, children,
}: Readonly<{
  state: ResourceState<T[]>;
  emptyIcon: typeof FileText;
  emptyText: string;
  onRetry: () => void;
  children: (data: T[]) => ReactNode;
}>) {
  if (state.status === "loading") {
    return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-destructive max-w-md">{state.message}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />إعادة المحاولة
        </Button>
      </div>
    );
  }
  if (state.data.length === 0) {
    return <EmptyState icon={emptyIcon} text={emptyText} />;
  }
  return <>{children(state.data)}</>;
}

// =========================================================================
// Main Component
// =========================================================================

export function ReportsCenter() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("new");

  const [initialState, setInitialState] = useState<ResourceState<InitialData>>({ status: "loading" });
  const [selectedType, setSelectedType] = useState<ReportType | null>(null);
  const [filters, setFilters] = useState<FiltersForm>(defaultFilters());
  const [options, setOptions] = useState<OptionsForm>({
    includeComparison: true, includeCharts: true, includeDetailedRows: false,
  });

  const [previewing, setPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState<ReportData | null>(null);
  const [exportingFormat, setExportingFormat] = useState<"PDF" | "XLSX" | null>(null);
  const previewRequestRef = useRef(0);

  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);

  const [templatesState, setTemplatesState] = useState<ResourceState<ReportTemplate[]>>({ status: "loading" });
  const [schedulesState, setSchedulesState] = useState<ResourceState<ReportSchedule[]>>({ status: "loading" });
  const [runsState, setRunsState] = useState<ResourceState<ReportRunRow[]>>({ status: "loading" });

  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [scheduleTemplateId, setScheduleTemplateId] = useState<string | null>(null);
  const [scheduleFrequency, setScheduleFrequency] = useState<"DAILY" | "WEEKLY" | "MONTHLY">("DAILY");
  const [scheduleTime, setScheduleTime] = useState("07:00");
  const [scheduleDayOfWeek, setScheduleDayOfWeek] = useState("0");
  const [scheduleDayOfMonth, setScheduleDayOfMonth] = useState("1");
  const [creatingSchedule, setCreatingSchedule] = useState(false);

  const definitions = initialState.status === "ready" ? initialState.data.definitions : null;
  const filtersData = initialState.status === "ready" ? initialState.data.filtersData : null;

  const loadInitialData = useCallback(async (signal?: AbortSignal) => {
    setInitialState({ status: "loading" });
    try {
      const [filtersBody, definitionsBody] = await Promise.all([
        fetchReportJson<FiltersData>("/api/filters", { signal }),
        fetchReportJson<{ definitions: ReportDefinition[] }>("/api/reports/definitions", { signal }),
      ]);
      setInitialState({ status: "ready", data: { filtersData: filtersBody, definitions: definitionsBody.definitions ?? [] } });
    } catch (error) {
      if (isAbortError(error)) return;
      setInitialState({ status: "error", message: messageFromError(error, "تعذر تحميل مركز التقارير") });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function run(): Promise<void> {
      await loadInitialData(controller.signal);
    }
    void run();
    return () => controller.abort();
  }, [loadInitialData]);

  const loadTemplates = useCallback(async (signal?: AbortSignal) => {
    setTemplatesState({ status: "loading" });
    try {
      const body = await fetchReportJson<{ templates: ReportTemplate[] }>(
        "/api/reports/templates?includeInactive=true",
        { signal }
      );
      setTemplatesState({ status: "ready", data: body.templates ?? [] });
    } catch (error) {
      if (isAbortError(error)) return;
      setTemplatesState({ status: "error", message: messageFromError(error, "تعذر جلب القوالب") });
    }
  }, []);

  const loadSchedules = useCallback(async (signal?: AbortSignal) => {
    setSchedulesState({ status: "loading" });
    try {
      const body = await fetchReportJson<{ schedules: ReportSchedule[] }>("/api/reports/schedules", { signal });
      setSchedulesState({ status: "ready", data: body.schedules ?? [] });
    } catch (error) {
      if (isAbortError(error)) return;
      setSchedulesState({ status: "error", message: messageFromError(error, "تعذر جلب الجداول") });
    }
  }, []);

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    setRunsState({ status: "loading" });
    try {
      const body = await fetchReportJson<{ runs: ReportRunRow[] }>("/api/reports/runs", { signal });
      setRunsState({ status: "ready", data: body.runs ?? [] });
    } catch (error) {
      if (isAbortError(error)) return;
      setRunsState({ status: "error", message: messageFromError(error, "تعذر جلب سجل التشغيلات") });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function loadActiveTab(): Promise<void> {
      if (activeTab === "templates") {
        await loadTemplates(controller.signal);
      } else if (activeTab === "schedules") {
        await Promise.all([loadSchedules(controller.signal), loadTemplates(controller.signal)]);
      } else if (activeTab === "history") {
        await loadRuns(controller.signal);
      }
    }
    void loadActiveTab();
    return () => controller.abort();
  }, [activeTab, loadTemplates, loadSchedules, loadRuns]);

  const selectedDefinition = definitions?.find((d) => d.type === selectedType) ?? null;

  const selectReportType = (type: ReportType) => {
    const definition = definitions?.find((d) => d.type === type) ?? null;
    setSelectedType(type);
    setPreviewData(null);
    setOptions({ includeComparison: true, includeCharts: true, includeDetailedRows: false });
    if (definition) {
      setFilters((prev) => resetUnsupportedFilters(prev, definition));
    }
  };

  const buildRequestBody = () => ({
    type: selectedType,
    filters: selectedDefinition ? buildSupportedFiltersPayload(filters, selectedDefinition) : {},
    options,
  });

  const handlePreview = async () => {
    if (!selectedType || !selectedDefinition) return;
    const periodError = validatePeriod(selectedDefinition, filters);
    if (periodError) {
      toast({ title: "تنبيه", description: periodError, variant: "destructive" });
      return;
    }
    const requestId = ++previewRequestRef.current;
    setPreviewing(true);
    setPreviewData(null);
    try {
      const body = await fetchReportJson<{ report: ReportData }>("/api/reports/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRequestBody()),
      });
      if (previewRequestRef.current !== requestId) return; // a newer preview request superseded this one
      setPreviewData(body.report);
    } catch (error) {
      if (previewRequestRef.current !== requestId) return;
      toast({ title: "خطأ", description: messageFromError(error, "فشل في المعاينة"), variant: "destructive" });
    } finally {
      if (previewRequestRef.current === requestId) setPreviewing(false);
    }
  };

  const downloadArtifact = (artifactId: string) => {
    // Same-tab navigation to an `attachment` response triggers a download
    // without leaving the page, and (unlike window.open) is never blocked by
    // popup blockers even when called after an awaited fetch.
    window.location.assign(`/api/reports/artifacts/${artifactId}/download`);
  };

  const handleExport = async (format: "PDF" | "XLSX") => {
    if (!selectedType || !selectedDefinition) return;
    const periodError = validatePeriod(selectedDefinition, filters);
    if (periodError) {
      toast({ title: "تنبيه", description: periodError, variant: "destructive" });
      return;
    }
    setExportingFormat(format);
    try {
      const body = await fetchReportJson<{ run: { artifacts: { id: string }[] } }>("/api/reports/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildRequestBody(), formats: [format] }),
      });
      const artifact = body.run?.artifacts?.[0];
      if (!artifact) throw new Error("لم يتم إنشاء ملف التصدير");
      downloadArtifact(artifact.id);
      toast({ title: "تم التصدير", description: `تم إنشاء ملف ${format} بنجاح` });
    } catch (error) {
      toast({ title: "خطأ", description: messageFromError(error, "فشل في التصدير"), variant: "destructive" });
    } finally {
      setExportingFormat(null);
    }
  };

  const handleSaveTemplate = async () => {
    if (!selectedType || !templateName.trim() || !selectedDefinition) return;
    setSavingTemplate(true);
    try {
      await fetchReportJson("/api/reports/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: templateName.trim(),
          reportType: selectedType,
          filters: buildSupportedFiltersPayload(filters, selectedDefinition),
          options,
        }),
      });
      toast({ title: "تم الحفظ", description: `تم حفظ القالب "${templateName.trim()}"` });
      setSaveDialogOpen(false);
      setTemplateName("");
    } catch (error) {
      toast({ title: "خطأ", description: messageFromError(error, "فشل في الحفظ"), variant: "destructive" });
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleRunTemplate = async (template: ReportTemplate) => {
    try {
      await fetchReportJson(`/api/reports/templates/${template.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      toast({ title: "تم التشغيل", description: `تم تشغيل قالب "${template.name}" بنجاح` });
      void loadTemplates();
      if (activeTab === "history") void loadRuns();
    } catch (error) {
      toast({ title: "خطأ", description: messageFromError(error, "فشل في التشغيل"), variant: "destructive" });
    }
  };

  const handleDisableTemplate = async (template: ReportTemplate) => {
    try {
      await fetchReportJson(`/api/reports/templates/${template.id}`, { method: "DELETE" });
      toast({ title: "تم التعطيل", description: `تم تعطيل القالب "${template.name}"` });
      void loadTemplates();
    } catch (error) {
      toast({ title: "خطأ", description: messageFromError(error, "فشل في التعطيل"), variant: "destructive" });
    }
  };

  const openScheduleDialog = (templateId: string) => {
    setScheduleTemplateId(templateId);
    setScheduleFrequency("DAILY");
    setScheduleTime("07:00");
    setScheduleDayOfWeek("0");
    setScheduleDayOfMonth("1");
    setScheduleDialogOpen(true);
  };

  const handleCreateSchedule = async () => {
    if (!scheduleTemplateId) return;
    setCreatingSchedule(true);
    try {
      await fetchReportJson("/api/reports/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportTemplateId: scheduleTemplateId,
          frequency: scheduleFrequency,
          timeOfDay: scheduleTime,
          dayOfWeek: scheduleFrequency === "WEEKLY" ? Number(scheduleDayOfWeek) : undefined,
          dayOfMonth: scheduleFrequency === "MONTHLY" ? Number(scheduleDayOfMonth) : undefined,
        }),
      });
      toast({ title: "تمت الجدولة", description: "تم إنشاء الجدولة بنجاح" });
      setScheduleDialogOpen(false);
      void loadSchedules();
      void loadTemplates();
    } catch (error) {
      toast({ title: "خطأ", description: messageFromError(error, "فشل في الجدولة"), variant: "destructive" });
    } finally {
      setCreatingSchedule(false);
    }
  };

  const handleDisableSchedule = async (schedule: ReportSchedule) => {
    try {
      await fetchReportJson(`/api/reports/schedules/${schedule.id}`, { method: "DELETE" });
      toast({ title: "تم التعطيل", description: "تم تعطيل الجدولة" });
      void loadSchedules();
    } catch (error) {
      toast({ title: "خطأ", description: messageFromError(error, "فشل في التعطيل"), variant: "destructive" });
    }
  };

  const flatClassifications = (filtersData?.classifications ?? []).flatMap((cat) => cat.children);

  return (
    <div className="space-y-6">
      <PageHeader
        title="مركز التقارير"
        description="إنشاء التقارير المؤسسية وتصديرها وجدولة تشغيلها التلقائي"
        icon={<FileText className="h-6 w-6" />}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="new"><Plus className="h-4 w-4" />إنشاء تقرير</TabsTrigger>
          <TabsTrigger value="templates"><Save className="h-4 w-4" />القوالب</TabsTrigger>
          <TabsTrigger value="schedules"><CalendarClock className="h-4 w-4" />الجداول</TabsTrigger>
          <TabsTrigger value="history"><History className="h-4 w-4" />سجل التشغيلات</TabsTrigger>
        </TabsList>

        {/* ================= NEW REPORT ================= */}
        <TabsContent value="new" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">1</span>
                اختر نوع التقرير
              </CardTitle>
            </CardHeader>
            <CardContent>
              {initialState.status === "loading" && (
                <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
              )}
              {initialState.status === "error" && (
                <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                  <AlertTriangle className="h-8 w-8 text-destructive" />
                  <p className="text-sm text-destructive max-w-md">{initialState.message}</p>
                  <Button size="sm" variant="outline" onClick={() => loadInitialData()}>
                    <RefreshCw className="h-4 w-4" />إعادة المحاولة
                  </Button>
                </div>
              )}
              {initialState.status === "ready" && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {initialState.data.definitions.map((def) => {
                    const Icon = REPORT_ICONS[def.type];
                    const isActive = selectedType === def.type;
                    return (
                      <button
                        key={def.type}
                        onClick={() => selectReportType(def.type)}
                        className={`text-right rounded-xl border-2 p-4 transition-all hover:shadow-md ${
                          isActive ? "border-primary bg-primary/5 shadow-sm" : "border-border hover:border-primary/40"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`flex h-11 w-11 items-center justify-center rounded-lg bg-gradient-to-br ${REPORT_COLORS[def.type]} text-white shadow-sm shrink-0`}>
                            <Icon className="h-6 w-6" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-base">{def.title}</h3>
                            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{def.description}</p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {selectedDefinition && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">2</span>
                  إعدادات التقرير
                </CardTitle>
                <CardDescription>حدد النطاق الزمني والفلاتر لـ«{selectedDefinition.title}»</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {requiresReportPeriod(selectedDefinition) && (
                    <>
                      <div className="space-y-2">
                        <Label>من تاريخ</Label>
                        <Input type="date" value={filters.from} onChange={(e) => setFilters((p) => ({ ...p, from: e.target.value }))} />
                      </div>
                      <div className="space-y-2">
                        <Label>إلى تاريخ</Label>
                        <Input type="date" value={filters.to} onChange={(e) => setFilters((p) => ({ ...p, to: e.target.value }))} />
                      </div>
                    </>
                  )}
                  {supportsFilter(selectedDefinition, "region") && (
                    <div className="space-y-2">
                      <Label>المنطقة</Label>
                      <Select value={filters.region} onValueChange={(v) => setFilters((p) => ({ ...p, region: v }))}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">الكل</SelectItem>
                          {filtersData?.regions.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {supportsFilter(selectedDefinition, "department") && (
                    <div className="space-y-2">
                      <Label>الإدارة</Label>
                      <Select value={filters.department} onValueChange={(v) => setFilters((p) => ({ ...p, department: v }))}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">الكل</SelectItem>
                          {filtersData?.departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {supportsFilter(selectedDefinition, "facility") && (
                    <div className="space-y-2">
                      <Label>الموقع</Label>
                      <Select value={filters.facility} onValueChange={(v) => setFilters((p) => ({ ...p, facility: v }))}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">الكل</SelectItem>
                          {filtersData?.facilities.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {supportsFilter(selectedDefinition, "classificationId") && (
                    <div className="space-y-2">
                      <Label>التصنيف</Label>
                      <Select value={filters.classificationId} onValueChange={(v) => setFilters((p) => ({ ...p, classificationId: v }))}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">الكل</SelectItem>
                          {flatClassifications.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {supportsFilter(selectedDefinition, "priority") && (
                    <div className="space-y-2">
                      <Label>الأولوية</Label>
                      <Select value={filters.priority} onValueChange={(v) => setFilters((p) => ({ ...p, priority: v }))}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">الكل</SelectItem>
                          {Object.entries(PRIORITY_LABELS_AR).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {supportsFilter(selectedDefinition, "status") && (
                    <div className="space-y-2">
                      <Label>الحالة</Label>
                      <Select value={filters.status} onValueChange={(v) => setFilters((p) => ({ ...p, status: v }))}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">الكل</SelectItem>
                          {Object.entries(STATUS_LABELS_AR).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                <Separator />

                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <Checkbox checked={options.includeComparison} onCheckedChange={() => setOptions((p) => ({ ...p, includeComparison: !p.includeComparison }))} />
                    مقارنة بالفترة السابقة
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <Checkbox checked={options.includeCharts} onCheckedChange={() => setOptions((p) => ({ ...p, includeCharts: !p.includeCharts }))} />
                    تضمين الرسوم
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <Checkbox checked={options.includeDetailedRows} onCheckedChange={() => setOptions((p) => ({ ...p, includeDetailedRows: !p.includeDetailedRows }))} />
                    تضمين جدول تفصيلي
                  </label>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => setSaveDialogOpen(true)}>
                    <Save className="h-4 w-4" />حفظ كقالب
                  </Button>
                  {selectedDefinition.supportsXlsx && (
                    <Button variant="outline" onClick={() => handleExport("XLSX")} disabled={exportingFormat !== null}>
                      {exportingFormat === "XLSX" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                      تصدير XLSX
                    </Button>
                  )}
                  {selectedDefinition.supportsPdf && (
                    <Button variant="outline" onClick={() => handleExport("PDF")} disabled={exportingFormat !== null}>
                      {exportingFormat === "PDF" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      تصدير PDF
                    </Button>
                  )}
                  <Button onClick={handlePreview} disabled={previewing} size="lg">
                    {previewing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                    معاينة
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {previewData && <ReportPreview data={previewData} />}
        </TabsContent>

        {/* ================= TEMPLATES ================= */}
        <TabsContent value="templates">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Save className="h-5 w-5" />القوالب المحفوظة</CardTitle>
              <CardDescription>القوالب المحفوظة مع إمكانية التشغيل الفوري أو الجدولة أو التعطيل</CardDescription>
            </CardHeader>
            <CardContent>
              <ResourceSection
                state={templatesState}
                emptyIcon={Save}
                emptyText="لا توجد قوالب محفوظة بعد"
                onRetry={() => loadTemplates()}
              >
                {(templates) => (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>الاسم</TableHead>
                        <TableHead>النوع</TableHead>
                        <TableHead>آخر تشغيل</TableHead>
                        <TableHead>الحالة</TableHead>
                        <TableHead>الجدولة</TableHead>
                        <TableHead className="text-left">إجراءات</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {templates.map((tpl) => {
                        const hasActiveSchedule = tpl.schedules.some((s) => s.isEnabled);
                        const activeScheduleCount = tpl.schedules.filter((s) => s.isEnabled).length;
                        return (
                          <TableRow key={tpl.id}>
                            <TableCell className="font-medium">{tpl.name}</TableCell>
                            <TableCell>{definitions?.find((d) => d.type === tpl.reportType)?.title ?? tpl.reportType}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{tpl.lastRunAt ? formatDateTime(tpl.lastRunAt) : "لم يُشغَّل بعد"}</TableCell>
                            <TableCell>
                              <Badge variant={tpl.isActive ? "secondary" : "outline"}>{tpl.isActive ? "مفعّل" : "معطّل"}</Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {hasActiveSchedule ? `${activeScheduleCount} جدولة نشطة` : "بدون جدولة"}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5 justify-end">
                                <Button size="sm" variant="ghost" onClick={() => handleRunTemplate(tpl)} disabled={!tpl.isActive}>
                                  <PlayCircle className="h-4 w-4" />تشغيل الآن
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => openScheduleDialog(tpl.id)} disabled={!tpl.isActive}>
                                  <Calendar className="h-4 w-4" />جدولة
                                </Button>
                                {tpl.isActive && (
                                  <Button size="sm" variant="ghost" onClick={() => handleDisableTemplate(tpl)}>
                                    <XCircle className="h-4 w-4 text-destructive" />تعطيل
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </ResourceSection>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================= SCHEDULES ================= */}
        <TabsContent value="schedules">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><CalendarClock className="h-5 w-5" />جداول التشغيل</CardTitle>
              <CardDescription>الجداول الداخلية لتشغيل القوالب تلقائياً وفق التكرار المحدد</CardDescription>
            </CardHeader>
            <CardContent>
              <ResourceSection
                state={schedulesState}
                emptyIcon={CalendarClock}
                emptyText="لا توجد جداول تشغيل بعد"
                onRetry={() => loadSchedules()}
              >
                {(schedules) => (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>القالب</TableHead>
                        <TableHead>التكرار</TableHead>
                        <TableHead>الموعد القادم</TableHead>
                        <TableHead>آخر تشغيل</TableHead>
                        <TableHead>الحالة</TableHead>
                        <TableHead className="text-left">إجراءات</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {schedules.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="font-medium">{s.reportTemplate?.name ?? "—"}</TableCell>
                          <TableCell>
                            {FREQUENCY_LABELS[s.frequency]} {s.timeOfDay}
                            {s.frequency === "WEEKLY" && s.dayOfWeek !== null ? ` (${WEEKDAY_LABELS[s.dayOfWeek]})` : ""}
                            {s.frequency === "MONTHLY" && s.dayOfMonth !== null ? ` (يوم ${s.dayOfMonth})` : ""}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{formatDateTime(s.nextRunAt)}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{s.lastRunAt ? formatDateTime(s.lastRunAt) : "—"}</TableCell>
                          <TableCell><Badge variant={s.isEnabled ? "secondary" : "outline"}>{s.isEnabled ? "مفعّلة" : "متوقفة"}</Badge></TableCell>
                          <TableCell className="text-left">
                            {s.isEnabled && (
                              <Button size="sm" variant="ghost" onClick={() => handleDisableSchedule(s)}>
                                <XCircle className="h-4 w-4 text-destructive" />إيقاف
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </ResourceSection>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================= HISTORY ================= */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><History className="h-5 w-5" />سجل تشغيل التقارير</CardTitle>
              <CardDescription>آخر عمليات توليد التقارير مع حالتها وملفاتها</CardDescription>
            </CardHeader>
            <CardContent>
              <ResourceSection
                state={runsState}
                emptyIcon={History}
                emptyText="لا توجد تشغيلات بعد"
                onRetry={() => loadRuns()}
              >
                {(runs) => (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>التقرير</TableHead>
                        <TableHead>الحالة</TableHead>
                        <TableHead>البدء</TableHead>
                        <TableHead>الانتهاء</TableHead>
                        <TableHead>الملفات</TableHead>
                        <TableHead>سبب الفشل</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((run) => (
                        <TableRow key={run.id}>
                          <TableCell className="font-medium">
                            {definitions?.find((d) => d.type === run.reportType)?.title ?? run.reportType}
                            {run.reportTemplate && <div className="text-xs text-muted-foreground">قالب: {run.reportTemplate.name}</div>}
                          </TableCell>
                          <TableCell>
                            <Badge variant={runStatusBadgeVariant(run.status)}>
                              {RUN_STATUS_LABELS[run.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{run.startedAt ? formatDateTime(run.startedAt) : "—"}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{run.completedAt ? formatDateTime(run.completedAt) : "—"}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1.5">
                              {run.artifacts.map((a) => (
                                <Button key={a.id} size="sm" variant="outline" onClick={() => downloadArtifact(a.id)}>
                                  <Download className="h-3.5 w-3.5" />
                                  {a.format} ({Math.round(a.fileSize / 1024)} كيلوبايت)
                                </Button>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-destructive max-w-[240px] truncate">{run.errorMessage ?? ""}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </ResourceSection>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Save Template Dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>حفظ القالب</DialogTitle>
            <DialogDescription>سيتم حفظ نوع التقرير والفلاتر والخيارات الحالية كقالب قابل لإعادة الاستخدام.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>اسم القالب</Label>
            <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="مثال: التقرير التنفيذي الشهري" />
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">إلغاء</Button></DialogClose>
            <Button onClick={handleSaveTemplate} disabled={savingTemplate || !templateName.trim()}>
              {savingTemplate ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Schedule Dialog */}
      <Dialog open={scheduleDialogOpen} onOpenChange={setScheduleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>إنشاء جدولة</DialogTitle>
            <DialogDescription>سيتم تشغيل هذا القالب تلقائياً وفق التكرار المحدد (بتوقيت الرياض).</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>التكرار</Label>
              <Select value={scheduleFrequency} onValueChange={(v) => setScheduleFrequency(v as typeof scheduleFrequency)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(FREQUENCY_LABELS).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>وقت التشغيل (بتوقيت الرياض)</Label>
              <Input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} />
            </div>
            {scheduleFrequency === "WEEKLY" && (
              <div className="space-y-2">
                <Label>يوم الأسبوع</Label>
                <Select value={scheduleDayOfWeek} onValueChange={setScheduleDayOfWeek}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WEEKDAY_LABELS.map((label, idx) => <SelectItem key={label} value={String(idx)}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {scheduleFrequency === "MONTHLY" && (
              <div className="space-y-2">
                <Label>يوم الشهر (إذا لم يوجد، يُستخدم آخر يوم في الشهر)</Label>
                <Input type="number" min={1} max={31} value={scheduleDayOfMonth} onChange={(e) => setScheduleDayOfMonth(e.target.value)} />
              </div>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">إلغاء</Button></DialogClose>
            <Button onClick={handleCreateSchedule} disabled={creatingSchedule}>
              {creatingSchedule ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
              إنشاء الجدولة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({ icon: Icon, text }: Readonly<{ icon: typeof FileText; text: string }>) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-3">
        <Icon className="h-7 w-7 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

// =========================================================================
// Preview
// =========================================================================

function assertNeverReportSection(section: never): never {
  throw new Error(`نوع قسم التقرير غير معروف: ${JSON.stringify((section as ReportSection).kind)}`);
}

function SectionBody({ section }: Readonly<{ section: ReportSection }>) {
  switch (section.kind) {
    case "kpi":
      return (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {section.cards.map((card) => (
            <div key={card.key} className="rounded-lg border bg-muted/40 p-3">
              <div className="text-xs text-muted-foreground">{card.label}</div>
              <div className="text-xl font-bold mt-1 tabular-nums">{formatKpiValue(card)}</div>
            </div>
          ))}
        </div>
      );

    case "table":
      if (section.table.rows.length === 0) {
        return <p className="text-sm text-muted-foreground">لا توجد بيانات لعرضها.</p>;
      }
      return (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                {section.table.columns.map((col) => <TableHead key={col.key}>{col.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {section.table.rows.map((row) => (
                <TableRow key={section.table.columns.map((col) => toDisplayText(row[col.key])).join("|")}>
                  {section.table.columns.map((col) => (
                    <TableCell key={col.key} className="text-sm">{formatCell(row[col.key], col.format)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {section.table.truncated && (
            <div className="p-2 text-xs text-muted-foreground border-t">
              تم عرض {section.table.rows.length} من أصل {formatNumber(section.table.totalMatched)} صفاً.
            </div>
          )}
        </div>
      );

    case "text":
      if (section.points.length === 0) {
        return <p className="text-sm text-muted-foreground">لا توجد بيانات لعرضها.</p>;
      }
      return (
        <ul className="space-y-1.5 list-disc list-inside">
          {section.points.map((point, i) => (
            <li key={i} className="text-sm">{point}</li>
          ))}
        </ul>
      );

    case "chart":
      return <ReportChartPreview section={section} />;

    default:
      return assertNeverReportSection(section);
  }
}

function ReportChartPreview({ section }: Readonly<{ section: Extract<ReportSection, { kind: "chart" }> }>) {
  if (section.series.length === 0) {
    return <p className="text-sm text-muted-foreground">{section.emptyState ?? "لا توجد بيانات لعرضها."}</p>;
  }
  const unit = section.unit ? ` ${section.unit}` : "";
  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
      {section.description && <p className="text-xs text-muted-foreground">{section.description}</p>}
      <div className="space-y-1">
        {section.series.map((series) => {
          const total = series.points.reduce((sum, pt) => sum + pt.y, 0);
          return (
            <div key={series.name} className="flex items-center justify-between text-sm py-0.5 border-b last:border-b-0">
              <span className="text-muted-foreground">{series.name}</span>
              <span className="font-medium tabular-nums">{formatNumber(total)}{unit}</span>
            </div>
          );
        })}
      </div>
      {section.truncated && section.truncatedMessage && (
        <p className="text-xs text-muted-foreground">{section.truncatedMessage}</p>
      )}
    </div>
  );
}

function ReportPreview({ data }: Readonly<{ data: ReportData }>) {
  return (
    <Card id="report-preview">
      <CardHeader className="border-b bg-muted/30">
        <CardTitle>{data.title}</CardTitle>
        <CardDescription>
          الفترة: {formatDate(data.period.from)} — {formatDate(data.period.to)} • تم الإنشاء: {formatDateTime(data.generatedAt)}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-6">
        {data.warnings.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-3 space-y-1">
            {data.warnings.map((w) => (
              <div key={w} className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{w}
              </div>
            ))}
          </div>
        )}
        {data.sections.map((section) => (
          <div key={section.id} className="space-y-3">
            <h3 className="font-semibold text-base">{section.title}</h3>
            <SectionBody section={section} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export { ReportApiError, fetchReportJson, supportsFilter, requiresReportPeriod, resetUnsupportedFilters, buildSupportedFiltersPayload, validatePeriod };
