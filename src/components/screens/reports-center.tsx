"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
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
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  FileText, FileBarChart, FileSpreadsheet, FileCheck, FileWarning,
  FileSearch, Download, Save, Calendar, Clock, Plus, Printer,
  TrendingUp, TrendingDown, AlertTriangle, CheckCircle2, XCircle,
  Activity, MapPin, Building2, Layers, RefreshCw, History, Settings2,
  Eye, ArrowUp, ArrowDown, Minus, Sparkles, ShieldAlert, Database,
  ClipboardList, PieChart, BarChart3, Lightbulb, Target,
} from "lucide-react";
import {
  formatNumber, formatPercent, formatDate, formatDateTime, formatDuration,
  STATUS_LABELS, PRIORITY_LABELS, SEVERITY_LABELS,
} from "@/lib/ar-utils";
import { fetchAllComplaintsForReport } from "@/lib/report-complaints";

// =========================================================================
// Types
// =========================================================================

type ReportTypeId =
  | "executive"
  | "regional"
  | "departmental"
  | "themes"
  | "time_comparison"
  | "data_quality";

interface FiltersData {
  regions: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  locations: { id: string; name: string; regionId: string | null }[];
  classifications: { id: string; name: string; children: { id: string; name: string }[] }[];
  channels: string[];
}

interface DashboardData {
  volume: {
    total: number; open: number; inProgress: number; closed: number;
    reopened: number; rejected: number; late: number; repeated: number;
    validated: number; notValidated: number; potentialDuplicates: number;
  };
  performance: {
    closureRate: number; onTimeRate: number; lateRate: number;
    avgFirstResponseHours: number; avgProcessingHours: number; avgOpenAgeHours: number;
    overdueNoAction: number; overdueNoActionRate: number; reopenRate: number;
    validityRate: number; avgSatisfaction: number; satisfactionRate: number;
  };
  trend: {
    previousTotal: number | null; growthRate: number | null;
    trendData: { date: string; total: number; closed: number }[];
  };
  distributions: {
    byRegion: { name: string; count: number }[];
    byDepartment: { name: string; count: number }[];
    byClassification: { name: string; count: number }[];
    byChannel: { name: string; count: number }[];
    byStatus: { name: string; count: number }[];
    byPriority: { name: string; count: number }[];
    bySeverity: { name: string; count: number }[];
  };
  alerts: {
    criticalComplaints: number; lateCritical: number;
    missingFields: number; dataQualityRate: number;
  };
}

interface ComplaintRow {
  id: string;
  complaintNumber: string;
  receivedDate: string;
  channel: string;
  regionId: string | null;
  region?: { name: string } | null;
  locationId: string | null;
  location?: { name: string; regionId: string | null } | null;
  departmentId: string | null;
  department?: { name: string } | null;
  classificationId: string | null;
  classification?: { name: string } | null;
  subject: string;
  description: string;
  status: string;
  priority: string;
  severity: string;
  referralDate: string | null;
  firstActionDate: string | null;
  closureDate: string | null;
  dueDate: string | null;
  resolution: string | null;
  delayReason: string | null;
  isRepeated: boolean;
  isValidated: boolean;
  beneficiarySatisfaction: number | null;
  isPotentialDuplicate: boolean;
  aiClassification?: string | null;
  aiConfidence?: number | null;
}

interface ImportBatchRow {
  id: string;
  fileName: string;
  status: string;
  totalRecords: number;
  validRecords: number;
  duplicateRecords: number;
  incompleteRecords: number;
  rejectedRecords: number;
  createdAt: string;
}

interface ReportConfig {
  from: string;
  to: string;
  regionId: string;
  departmentId: string;
  indicators: Record<string, boolean>;
}

interface SavedTemplate {
  id: string;
  name: string;
  type: ReportTypeId;
  config: ReportConfig;
  createdAt: string;
  frequency?: string;
}

interface HistoryEntry {
  id: string;
  type: ReportTypeId;
  title: string;
  period: string;
  scope: string;
  generatedAt: string;
}

// =========================================================================
// Report type registry
// =========================================================================

interface ReportTypeMeta {
  id: ReportTypeId;
  title: string;
  shortTitle: string;
  description: string;
  icon: typeof FileText;
  color: string;
  indicators: { key: string; label: string }[];
}

const REPORT_TYPES: ReportTypeMeta[] = [
  {
    id: "executive",
    title: "التقرير التنفيذي",
    shortTitle: "تنفيذي",
    description: "نظرة شاملة على أداء النظام والمؤشرات الرئيسية والتوصيات التحسينية",
    icon: FileText,
    color: "from-emerald-500 to-teal-600",
    indicators: [
      { key: "volume", label: "أحجام الشكاوى" },
      { key: "performance", label: "مؤشرات الأداء" },
      { key: "classifications", label: "التصنيفات الأبرز" },
      { key: "regions", label: "المناطق الأبرز" },
      { key: "critical", label: "الشكاوى الحرجة والمتأخرة" },
      { key: "compliance", label: "إدارات ذات امتثال منخفض" },
      { key: "recurring", label: "الأنماط المتكررة" },
      { key: "delays", label: "أسباب التأخير" },
      { key: "opportunities", label: "فرص التحسين" },
    ],
  },
  {
    id: "regional",
    title: "تقرير أداء المناطق",
    shortTitle: "أداء المناطق",
    description: "تحليل أداء كل منطقة صحية مع معدلات الإغلاق والمعالجة والالتزام",
    icon: FileBarChart,
    color: "from-sky-500 to-cyan-600",
    indicators: [
      { key: "volumes", label: "أحمال الشكاوى" },
      { key: "closure", label: "معدلات الإغلاق" },
      { key: "ontime", label: "نسبة الالتزام بالمواعيد" },
      { key: "processing", label: "متوسط زمن المعالجة" },
      { key: "classifications", label: "أبرز التصنيفات" },
      { key: "highlights", label: "نقاط التميز والقصور" },
    ],
  },
  {
    id: "departmental",
    title: "تقرير أداء الإدارات",
    shortTitle: "أداء الإدارات",
    description: "تقييم أداء الإدارات في معالجة الشكاوى وتحديد إجراءاتها ومدى التزامها",
    icon: FileSpreadsheet,
    color: "from-violet-500 to-purple-600",
    indicators: [
      { key: "assignments", label: "إحالات الإدارات" },
      { key: "completion", label: "معدلات الإنجاز" },
      { key: "late", label: "الشكاوى المتأخرة" },
      { key: "response", label: "متوسط أول إجراء" },
      { key: "closure", label: "متوسط الإغلاق" },
      { key: "delays", label: "أسباب التأخير" },
      { key: "trend", label: "الاتجاه الزمني" },
    ],
  },
  {
    id: "themes",
    title: "تقرير الموضوعات المتكررة",
    shortTitle: "موضوعات متكررة",
    description: "رصد الموضوعات الأكثر تكراراً ومواقع تأثيرها وحالة معالجة أسبابها الجذرية",
    icon: FileCheck,
    color: "from-amber-500 to-orange-600",
    indicators: [
      { key: "subjects", label: "الموضوعات المتكررة" },
      { key: "locations", label: "المواقع المتأثرة" },
      { key: "firstlast", label: "أول وآخر ظهور" },
      { key: "rate", label: "معدل التكرار" },
      { key: "severity", label: "درجة الخطورة" },
      { key: "rootcause", label: "حالة السبب الجذري" },
    ],
  },
  {
    id: "time_comparison",
    title: "تقرير المقارنة الزمنية",
    shortTitle: "مقارنة زمنية",
    description: "مقارنة الفترة الحالية بالسابقة لرصد التحسن والتراجع في المؤشرات والتصنيفات",
    icon: FileWarning,
    color: "from-rose-500 to-pink-600",
    indicators: [
      { key: "totals", label: "إجمالي الشكاوى" },
      { key: "performance", label: "مؤشرات الأداء" },
      { key: "classifications", label: "تحسن/تراجع التصنيفات" },
      { key: "regions", label: "تحسن/تراجع المناطق" },
      { key: "exceptions", label: "التغيرات الاستثنائية" },
    ],
  },
  {
    id: "data_quality",
    title: "تقرير جودة البيانات",
    shortTitle: "جودة البيانات",
    description: "تدقيق جودة بيانات الشكاوى ورصد النواقص والتكرارات والحالات غير المنطقية",
    icon: FileSearch,
    color: "from-slate-500 to-zinc-600",
    indicators: [
      { key: "missing", label: "الحقول المفقودة" },
      { key: "duplicates", label: "السجلات المكررة" },
      { key: "illogical", label: "التواريخ غير المنطقية" },
      { key: "unapproved", label: "الحالات غير المعتمدة" },
      { key: "noncompliant", label: "الكيانات غير الملتزمة" },
      { key: "unclassifiable", label: "السجلات غير القابلة للتصنيف" },
    ],
  },
];

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

const FREQUENCY_OPTIONS = [
  { value: "daily", label: "يومي" },
  { value: "weekly", label: "أسبوعي" },
  { value: "monthly", label: "شهري" },
  { value: "quarterly", label: "ربعي" },
];

// =========================================================================
// Helpers
// =========================================================================

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    from: formatLocalDate(from),
    to: formatLocalDate(to),
  };
}

function previousRange(from: string, to: string): { from: string; to: string } {
  const start = new Date(from);
  const end = new Date(to);
  const diff = end.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - diff - 24 * 60 * 60 * 1000);
  const prevEnd = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  return {
    from: formatLocalDate(prevStart),
    to: formatLocalDate(prevEnd),
  };
}

function formatRange(from: string, to: string): string {
  return `${formatDate(from)} — ${formatDate(to)}`;
}

function statusLabel(s: string) {
  return STATUS_LABELS[s] || s;
}
function priorityLabel(p: string) {
  return PRIORITY_LABELS[p] || p;
}
function severityLabel(s: string) {
  return SEVERITY_LABELS[s] || s;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function isLateComplaint(c: ComplaintRow): boolean {
  const now = new Date();
  if (c.status === "closed" && c.closureDate && c.dueDate) {
    return new Date(c.closureDate) > new Date(c.dueDate);
  }
  if (c.status === "rejected") return false;
  return c.dueDate ? now > new Date(c.dueDate) : false;
}

function isCritical(c: ComplaintRow): boolean {
  return c.severity === "critical" || c.priority === "critical";
}

// Group complaints by a key function
function groupBy<T, K extends string | number>(
  arr: T[], fn: (item: T) => K
): { key: K; items: T[] }[] {
  const map = new Map<K, T[]>();
  for (const item of arr) {
    const k = fn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return Array.from(map.entries()).map(([key, items]) => ({ key, items }));
}

// =========================================================================
// Main Component
// =========================================================================

export function ReportsCenter() {
  const { toast } = useToast();
  const reportAbortControllerRef = useRef<AbortController | null>(null);
  const [filters, setFilters] = useState<FiltersData | null>(null);
  const [activeTab, setActiveTab] = useState<string>("new");

  const [selectedType, setSelectedType] = useState<ReportTypeId | null>(null);
  const [config, setConfig] = useState<ReportConfig>(() => {
    const r = defaultRange();
    return {
      from: r.from, to: r.to, regionId: "all", departmentId: "all",
      indicators: {},
    };
  });

  const [generating, setGenerating] = useState(false);
  const [currentReport, setCurrentReport] = useState<{
    type: ReportTypeId;
    config: ReportConfig;
    dashboard: DashboardData | null;
    complaints: ComplaintRow[];
    importBatches: ImportBatchRow[];
    previousDashboard?: DashboardData | null;
    generatedAt: string;
  } | null>(null);

  const [templates, setTemplates] = useState<SavedTemplate[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [scheduleFreq, setScheduleFreq] = useState("monthly");

  // Load filters
  useEffect(() => {
    fetch("/api/filters")
      .then(r => r.json())
      .then(data => setFilters(data))
      .catch(e => console.error("filters error", e));
  }, []);

  useEffect(() => () => {
    reportAbortControllerRef.current?.abort();
  }, []);

  // When selecting a report type, init its indicators to all true
  const selectReportType = useCallback((typeId: ReportTypeId) => {
    const meta = REPORT_TYPES.find(t => t.id === typeId)!;
    const indicators: Record<string, boolean> = {};
    meta.indicators.forEach(ind => { indicators[ind.key] = true; });
    setConfig(prev => ({ ...prev, indicators }));
    setSelectedType(typeId);
    setCurrentReport(null);
  }, []);

  const updateConfig = (patch: Partial<ReportConfig>) => {
    setConfig(prev => ({ ...prev, ...patch }));
  };

  const toggleIndicator = (key: string) => {
    setConfig(prev => ({
      ...prev,
      indicators: { ...prev.indicators, [key]: !prev.indicators[key] },
    }));
  };

  // Build query string from config
  const buildQuery = (cfg: ReportConfig) => {
    const p = new URLSearchParams();
    p.set("from", cfg.from);
    p.set("to", cfg.to);
    if (cfg.regionId && cfg.regionId !== "all") p.set("regionId", cfg.regionId);
    if (cfg.departmentId && cfg.departmentId !== "all") p.set("departmentId", cfg.departmentId);
    return p.toString();
  };

  // Fetch all data needed for the selected report type
  const generateReport = useCallback(async () => {
    if (!selectedType) {
      toast({ title: "تنبيه", description: "يرجى اختيار نوع التقرير أولاً", variant: "destructive" });
      return;
    }
    reportAbortControllerRef.current?.abort();
    const controller = new AbortController();
    reportAbortControllerRef.current = controller;
    setGenerating(true);
    try {
      const qs = buildQuery(config);
      const complaintQuery = new URLSearchParams(qs);
      const [dashRes, compRes, impRes] = await Promise.all([
        fetch(`/api/dashboard?${qs}`, { signal: controller.signal }).then(r => r.json()),
        fetchAllComplaintsForReport<ComplaintRow>(complaintQuery, controller.signal),
        fetch(`/api/import/history`, { signal: controller.signal }).then(r => r.json().catch(() => [])),
      ]);
      const complaints: ComplaintRow[] = compRes;

      let previousDashboard: DashboardData | null = null;
      if (selectedType === "time_comparison") {
        const pr = previousRange(config.from, config.to);
        const prevQs = buildQuery({ ...config, from: pr.from, to: pr.to });
        previousDashboard = await fetch(`/api/dashboard?${prevQs}`, { signal: controller.signal }).then(r => r.json());
      }

      const report = {
        type: selectedType,
        config,
        dashboard: dashRes as DashboardData,
        complaints,
        importBatches: (impRes || []) as ImportBatchRow[],
        previousDashboard,
        generatedAt: new Date().toISOString(),
      };
      setCurrentReport(report);

      // Add to history
      const meta = REPORT_TYPES.find(t => t.id === selectedType)!;
      const scopeParts: string[] = [];
      if (config.regionId !== "all") {
        const r = filters?.regions.find(x => x.id === config.regionId);
        if (r) scopeParts.push(`منطقة: ${r.name}`);
      }
      if (config.departmentId !== "all") {
        const d = filters?.departments.find(x => x.id === config.departmentId);
        if (d) scopeParts.push(`إدارة: ${d.name}`);
      }
      const newHistory: HistoryEntry = {
        id: `h-${Date.now()}`,
        type: selectedType,
        title: meta.title,
        period: formatRange(config.from, config.to),
        scope: scopeParts.length > 0 ? scopeParts.join(" • ") : "كل النطاق",
        generatedAt: report.generatedAt,
      };
      setHistory(prev => [newHistory, ...prev].slice(0, 30));

      toast({
        title: "تم توليد التقرير",
        description: `تم إنشاء ${meta.title} بنجاح`,
      });
      // Scroll to report
      setTimeout(() => {
        document.getElementById("report-display")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        return;
      }
      console.error(e);
      toast({ title: "خطأ", description: "فشل في توليد التقرير", variant: "destructive" });
    } finally {
      if (reportAbortControllerRef.current === controller) {
        reportAbortControllerRef.current = null;
        setGenerating(false);
      }
    }
  }, [selectedType, config, filters, toast]);

  const handleExport = (kind: "pdf" | "excel") => {
    toast({
      title: kind === "pdf" ? "تصدير PDF" : "تصدير Excel",
      description: "جاري التصدير...",
    });
    setTimeout(() => {
      toast({
        title: "اكتمل التصدير",
        description: `تم تصدير التقرير بصيغة ${kind === "pdf" ? "PDF" : "Excel"} (تجريبي)`,
      });
    }, 1200);
  };

  const handlePrint = () => {
    window.print();
  };

  const handleSaveTemplate = () => {
    if (!selectedType) return;
    const name = templateName.trim() || `قالب ${REPORT_TYPES.find(t => t.id === selectedType)?.shortTitle}`;
    const tpl: SavedTemplate = {
      id: `t-${Date.now()}`,
      name,
      type: selectedType,
      config: { ...config },
      createdAt: new Date().toISOString(),
    };
    setTemplates(prev => [tpl, ...prev]);
    setTemplateName("");
    setSaveDialogOpen(false);
    toast({ title: "تم حفظ القالب", description: `تم حفظ القالب "${name}"` });
  };

  const handleSchedule = () => {
    if (!selectedType) return;
    const name = templateName.trim() || `مجدول ${REPORT_TYPES.find(t => t.id === selectedType)?.shortTitle}`;
    const tpl: SavedTemplate = {
      id: `s-${Date.now()}`,
      name,
      type: selectedType,
      config: { ...config },
      createdAt: new Date().toISOString(),
      frequency: scheduleFreq,
    };
    setTemplates(prev => [tpl, ...prev]);
    setTemplateName("");
    setScheduleDialogOpen(false);
    const freqLabel = FREQUENCY_OPTIONS.find(f => f.value === scheduleFreq)?.label;
    toast({ title: "تمت الجدولة", description: `سيتم توليد التقرير بتكرار ${freqLabel}` });
  };

  const applyTemplate = (tpl: SavedTemplate) => {
    setSelectedType(tpl.type);
    setConfig(tpl.config);
    setActiveTab("new");
    toast({ title: "تم تحميل القالب", description: `"${tpl.name}"` });
  };

  const deleteTemplate = (id: string) => {
    setTemplates(prev => prev.filter(t => t.id !== id));
    toast({ title: "تم الحذف", description: "تم حذف القالب" });
  };

  const clearHistory = () => {
    setHistory([]);
    toast({ title: "تم مسح السجل" });
  };

  const selectedMeta = selectedType
    ? REPORT_TYPES.find(t => t.id === selectedType) || null
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="مركز التقارير"
        description="توليد وإدارة التقارير التحليلية الشاملة للشكاوى وأداء النظام"
        icon={<FileText className="h-6 w-6" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setActiveTab("templates")}>
              <Save className="h-4 w-4" />
              القوالب المحفوظة
              {templates.length > 0 && (
                <Badge variant="secondary" className="mr-1">{templates.length}</Badge>
              )}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setActiveTab("history")}>
              <History className="h-4 w-4" />
              السجل
              {history.length > 0 && (
                <Badge variant="secondary" className="mr-1">{history.length}</Badge>
              )}
            </Button>
          </>
        }
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="new"><Plus className="h-4 w-4" />توليد تقرير</TabsTrigger>
          <TabsTrigger value="templates"><Save className="h-4 w-4" />القوالب المحفوظة</TabsTrigger>
          <TabsTrigger value="history"><History className="h-4 w-4" />سجل التقارير</TabsTrigger>
        </TabsList>

        {/* ====================================================== */}
        {/* NEW REPORT TAB                                          */}
        {/* ====================================================== */}
        <TabsContent value="new" className="space-y-6">
          {/* Step 1: Select type */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">1</span>
                اختر نوع التقرير
              </CardTitle>
              <CardDescription>
                حدد نوع التقرير المطلوب توليده من الأنواع التالية
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {REPORT_TYPES.map(rt => {
                  const Icon = rt.icon;
                  const isActive = selectedType === rt.id;
                  return (
                    <button
                      key={rt.id}
                      onClick={() => selectReportType(rt.id)}
                      className={`text-right rounded-xl border-2 p-4 transition-all hover:shadow-md ${
                        isActive
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border hover:border-primary/40"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`flex h-11 w-11 items-center justify-center rounded-lg bg-gradient-to-br ${rt.color} text-white shadow-sm shrink-0`}>
                          <Icon className="h-6 w-6" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="font-semibold text-base">{rt.title}</h3>
                            {isActive && (
                              <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                            {rt.description}
                          </p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Step 2: Configure */}
          {selectedMeta && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">2</span>
                  إعدادات التقرير
                </CardTitle>
                <CardDescription>
                  حدد النطاق الزمني والكيان والمؤشرات المطلوب تضمينها في «{selectedMeta.title}»
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Date range & scope */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5" />
                      من تاريخ
                    </Label>
                    <Input
                      type="date"
                      value={config.from}
                      onChange={e => updateConfig({ from: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5" />
                      إلى تاريخ
                    </Label>
                    <Input
                      type="date"
                      value={config.to}
                      onChange={e => updateConfig({ to: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5" />
                      المنطقة
                    </Label>
                    <Select
                      value={config.regionId}
                      onValueChange={v => updateConfig({ regionId: v })}
                    >
                      <SelectTrigger className="w-full"><SelectValue placeholder="الكل" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">جميع المناطق</SelectItem>
                        {filters?.regions.map(r => (
                          <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      <Building2 className="h-3.5 w-3.5" />
                      الإدارة
                    </Label>
                    <Select
                      value={config.departmentId}
                      onValueChange={v => updateConfig({ departmentId: v })}
                    >
                      <SelectTrigger className="w-full"><SelectValue placeholder="الكل" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">جميع الإدارات</SelectItem>
                        {filters?.departments.map(d => (
                          <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Quick date presets */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">إعدادات سريعة:</span>
                  {[
                    { label: "آخر 7 أيام", days: 7 },
                    { label: "آخر 30 يوم", days: 30 },
                    { label: "آخر 90 يوم", days: 90 },
                    { label: "آخر سنة", days: 365 },
                  ].map(preset => (
                    <Button
                      key={preset.days}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const to = new Date();
                        const from = new Date();
                        from.setDate(from.getDate() - preset.days);
                        updateConfig({
                          from: formatLocalDate(from),
                          to: formatLocalDate(to),
                        });
                      }}
                    >
                      <Clock className="h-3.5 w-3.5" />
                      {preset.label}
                    </Button>
                  ))}
                </div>

                <Separator />

                {/* Indicators */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-1.5 text-sm font-medium">
                    <Settings2 className="h-3.5 w-3.5" />
                    المؤشرات المضمّنة في التقرير
                  </Label>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 rounded-lg border bg-muted/30 p-4">
                    {selectedMeta.indicators.map(ind => (
                      <label
                        key={ind.key}
                        className="flex items-center gap-2 cursor-pointer text-sm hover:bg-background/60 rounded-md px-2 py-1.5 transition-colors"
                      >
                        <Checkbox
                          checked={!!config.indicators[ind.key]}
                          onCheckedChange={() => toggleIndicator(ind.key)}
                        />
                        <span>{ind.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => setSaveDialogOpen(true)}>
                    <Save className="h-4 w-4" />
                    حفظ كقالب
                  </Button>
                  <Button variant="outline" onClick={() => setScheduleDialogOpen(true)}>
                    <Calendar className="h-4 w-4" />
                    جدولة التقرير
                  </Button>
                  <Button
                    onClick={generateReport}
                    disabled={generating}
                    size="lg"
                  >
                    {generating ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    توليد التقرير
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 3: Report Display */}
          {currentReport && (
            <div id="report-display">
              <ReportView
                report={currentReport}
                onExport={handleExport}
                onPrint={handlePrint}
                onSaveTemplate={() => setSaveDialogOpen(true)}
                onSchedule={() => setScheduleDialogOpen(true)}
              />
            </div>
          )}

          {!currentReport && selectedMeta && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-3">
                  <FileText className="h-7 w-7 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground max-w-md">
                  اضغط «توليد التقرير» لإنشاء تقرير «{selectedMeta.title}» بناءً على الإعدادات المحددة
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ====================================================== */}
        {/* TEMPLATES TAB                                          */}
        {/* ====================================================== */}
        <TabsContent value="templates">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Save className="h-5 w-5" />
                القوالب المحفوظة والمجدولة
              </CardTitle>
              <CardDescription>
                قوالب التقارير المحفوظة محلياً مع إمكانية إعادة التوليد أو الجدولة
              </CardDescription>
            </CardHeader>
            <CardContent>
              {templates.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-3">
                    <Save className="h-7 w-7 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    لا توجد قوالب محفوظة بعد. احفظ قالباً من شاشة التوليد.
                  </p>
                </div>
              ) : (
                <div className="grid gap-3">
                  {templates.map(tpl => {
                    const meta = REPORT_TYPES.find(t => t.id === tpl.type)!;
                    const Icon = meta.icon;
                    return (
                      <div
                        key={tpl.id}
                        className="flex items-center gap-4 rounded-lg border p-4 hover:bg-muted/30 transition-colors"
                      >
                        <div className={`flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br ${meta.color} text-white shrink-0`}>
                          <Icon className="h-5 w-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h4 className="font-semibold">{tpl.name}</h4>
                            {tpl.frequency && (
                              <Badge variant="secondary" className="gap-1">
                                <Calendar className="h-3 w-3" />
                                {FREQUENCY_OPTIONS.find(f => f.value === tpl.frequency)?.label}
                              </Badge>
                            )}
                            <Badge variant="outline">{meta.shortTitle}</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            النطاق: {formatRange(tpl.config.from, tpl.config.to)} •
                            {" "}تم الحفظ: {formatDateTime(tpl.createdAt)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => applyTemplate(tpl)}>
                            <Eye className="h-4 w-4" />
                            تطبيق
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteTemplate(tpl.id)}>
                            <XCircle className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ====================================================== */}
        {/* HISTORY TAB                                            */}
        {/* ====================================================== */}
        <TabsContent value="history">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <History className="h-5 w-5" />
                  سجل التقارير المولّدة
                </CardTitle>
                <CardDescription>
                  التقارير التي تم توليدها في الجلسة الحالية
                </CardDescription>
              </div>
              {history.length > 0 && (
                <Button variant="outline" size="sm" onClick={clearHistory}>
                  <XCircle className="h-4 w-4" />
                  مسح السجل
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-3">
                    <History className="h-7 w-7 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    لا توجد تقارير في السجل بعد
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>نوع التقرير</TableHead>
                      <TableHead>النطاق الزمني</TableHead>
                      <TableHead>النطاق الإداري</TableHead>
                      <TableHead>وقت التوليد</TableHead>
                      <TableHead className="text-left">إجراء</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map(h => {
                      const meta = REPORT_TYPES.find(t => t.id === h.type)!;
                      const Icon = meta.icon;
                      return (
                        <TableRow key={h.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className={`flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br ${meta.color} text-white`}>
                                <Icon className="h-4 w-4" />
                              </div>
                              <span className="font-medium">{h.title}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">{h.period}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">{h.scope}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">{formatDateTime(h.generatedAt)}</TableCell>
                          <TableCell>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setActiveTab("new");
                                setSelectedType(h.type);
                              }}
                            >
                              <Eye className="h-4 w-4" />
                              عرض
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Save Template Dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>حفظ القالب</DialogTitle>
            <DialogDescription>
              أدخل اسماً للقالب. سيتم حفظه محلياً ويمكن إعادة استخدامه لاحقاً.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>اسم القالب</Label>
              <Input
                value={templateName}
                onChange={e => setTemplateName(e.target.value)}
                placeholder={selectedMeta ? `قالب ${selectedMeta.shortTitle}` : "اسم القالب"}
              />
            </div>
            {selectedMeta && (
              <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
                <div>النوع: {selectedMeta.title}</div>
                <div>النطاق: {formatRange(config.from, config.to)}</div>
                <div>
                  المؤشرات: {selectedMeta.indicators.filter(i => config.indicators[i.key]).length} من {selectedMeta.indicators.length}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">إلغاء</Button>
            </DialogClose>
            <Button onClick={handleSaveTemplate}>
              <Save className="h-4 w-4" />
              حفظ القالب
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Schedule Dialog */}
      <Dialog open={scheduleDialogOpen} onOpenChange={setScheduleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>جدولة التقرير</DialogTitle>
            <DialogDescription>
              حدد تكرار التوليد التلقائي للتقرير. (ميزة تجريبية)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>اسم التقرير المجدول</Label>
              <Input
                value={templateName}
                onChange={e => setTemplateName(e.target.value)}
                placeholder={selectedMeta ? `مجدول ${selectedMeta.shortTitle}` : "اسم التقرير"}
              />
            </div>
            <div className="space-y-2">
              <Label>تكرار التوليد</Label>
              <Select value={scheduleFreq} onValueChange={setScheduleFreq}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FREQUENCY_OPTIONS.map(f => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-3">
              <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 dark:text-amber-300">
                الجدولة ميزة تجريبية. سيتم حفظ الإعداد كقالب مع وسم التكرار دون تفعيل تلقائي فعلي.
              </p>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">إلغاء</Button>
            </DialogClose>
            <Button onClick={handleSchedule}>
              <Calendar className="h-4 w-4" />
              جدولة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =========================================================================
// Report View Container
// =========================================================================

interface ReportViewProps {
  report: {
    type: ReportTypeId;
    config: ReportConfig;
    dashboard: DashboardData | null;
    complaints: ComplaintRow[];
    importBatches: ImportBatchRow[];
    previousDashboard?: DashboardData | null;
    generatedAt: string;
  };
  onExport: (kind: "pdf" | "excel") => void;
  onPrint: () => void;
  onSaveTemplate: () => void;
  onSchedule: () => void;
}

function ReportView({ report, onExport, onPrint, onSaveTemplate, onSchedule }: ReportViewProps) {
  const meta = REPORT_TYPES.find(t => t.id === report.type)!;
  const Icon = meta.icon;

  return (
    <Card className="print:shadow-none print:border-0">
      {/* Report Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b p-4 bg-muted/30 print:hidden">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br ${meta.color} text-white shrink-0`}>
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-semibold">{meta.title}</h3>
            <p className="text-xs text-muted-foreground">
              تم التوليد: {formatDateTime(report.generatedAt)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => onExport("pdf")}>
            <Download className="h-3.5 w-3.5" />
            تصدير PDF
          </Button>
          <Button size="sm" variant="outline" onClick={() => onExport("excel")}>
            <FileSpreadsheet className="h-3.5 w-3.5" />
            تصدير Excel
          </Button>
          <Button size="sm" variant="outline" onClick={onPrint}>
            <Printer className="h-3.5 w-3.5" />
            طباعة
          </Button>
          <Button size="sm" variant="outline" onClick={onSaveTemplate}>
            <Save className="h-3.5 w-3.5" />
            حفظ كقالب
          </Button>
          <Button size="sm" variant="outline" onClick={onSchedule}>
            <Calendar className="h-3.5 w-3.5" />
            جدولة
          </Button>
        </div>
      </div>

      {/* Report Content */}
      <CardContent className="p-6 print:p-0">
        <ReportContent report={report} />
      </CardContent>
    </Card>
  );
}

// =========================================================================
// Report Content Router
// =========================================================================

function ReportContent({ report }: { report: ReportViewProps["report"] }) {
  switch (report.type) {
    case "executive":
      return <ExecutiveReport report={report} />;
    case "regional":
      return <RegionalReport report={report} />;
    case "departmental":
      return <DepartmentalReport report={report} />;
    case "themes":
      return <ThemesReport report={report} />;
    case "time_comparison":
      return <TimeComparisonReport report={report} />;
    case "data_quality":
      return <DataQualityReport report={report} />;
    default:
      return null;
  }
}

// =========================================================================
// Shared Report Building Blocks
// =========================================================================

function ReportCover({
  title, subtitle, period, scope, generatedAt, icon: Icon, color,
}: {
  title: string;
  subtitle: string;
  period: string;
  scope: string;
  generatedAt: string;
  icon: typeof FileText;
  color: string;
}) {
  return (
    <div className={`rounded-xl bg-gradient-to-br ${color} text-white p-6 mb-6 print:break-inside-avoid`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm shrink-0">
            <Icon className="h-7 w-7" />
          </div>
          <div>
            <h2 className="text-2xl font-bold">{title}</h2>
            <p className="text-sm text-white/85 mt-1">{subtitle}</p>
          </div>
        </div>
        <div className="text-left text-xs text-white/85 space-y-1 shrink-0 hidden md:block">
          <div className="flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" />{period}</div>
          <div className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />{scope}</div>
          <div className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />{formatDateTime(generatedAt)}</div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ icon: Icon, title, action }: {
  icon: typeof FileText; title: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3 print:break-after-avoid">
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </h3>
      {action}
    </div>
  );
}

function KpiCard({ label, value, sub, icon: Icon, tone = "default" }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  icon?: typeof FileText; tone?: "default" | "success" | "warning" | "danger" | "info";
}) {
  const toneClasses = {
    default: "bg-muted/40 text-foreground",
    success: "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400",
    warning: "bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400",
    danger: "bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400",
    info: "bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400",
  };
  return (
    <div className={`rounded-lg border p-3 ${toneClasses[tone]}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {Icon && <Icon className="h-4 w-4 opacity-70" />}
      </div>
      <div className="text-xl font-bold mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function InsightBox({ children, tone = "info" }: {
  children: React.ReactNode; tone?: "info" | "success" | "warning" | "danger";
}) {
  const tones = {
    info: "border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/30",
    success: "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30",
    warning: "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30",
    danger: "border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30",
  };
  return (
    <div className={`border rounded-lg p-3 text-sm ${tones[tone]} print:break-inside-avoid`}>
      {children}
    </div>
  );
}

function DeltaBadge({ value, suffix = "%" }: { value: number; suffix?: string }) {
  if (value === 0) {
    return <Badge variant="outline" className="gap-1"><Minus className="h-3 w-3" />بدون تغير</Badge>;
  }
  const positive = value > 0;
  return (
    <Badge
      variant="outline"
      className={`gap-1 ${
        positive
          ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-400"
          : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400"
      }`}
    >
      {positive ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.abs(value)}{suffix}
    </Badge>
  );
}

function scopeText(config: ReportConfig): string {
  const parts: string[] = [];
  if (config.regionId !== "all") parts.push("منطقة محددة");
  if (config.departmentId !== "all") parts.push("إدارة محددة");
  return parts.length > 0 ? parts.join(" • ") : "كل النطاق";
}

// =========================================================================
// 1. Executive Report
// =========================================================================

function ExecutiveReport({ report }: { report: ReportViewProps["report"] }) {
  const { config, dashboard, complaints, generatedAt } = report;
  const v = dashboard?.volume;
  const p = dashboard?.performance;
  const a = dashboard?.alerts;
  const t = dashboard?.trend;
  const indicators = config.indicators;

  const scope = scopeText(config);
  const period = formatRange(config.from, config.to);

  // Compute low-compliance departments (closure rate < 70%)
  const deptStats = useMemo(() => {
    const groups = groupBy(complaints, c => c.department?.name || "غير محدد");
    return groups.map(g => {
      const total = g.items.length;
      const closed = g.items.filter(c => c.status === "closed").length;
      const late = g.items.filter(isLateComplaint).length;
      const closureRate = pct(closed, total);
      return { name: g.key, total, closed, late, closureRate };
    }).sort((x, y) => x.closureRate - y.closureRate);
  }, [complaints]);
  const lowComplianceDepts = deptStats.filter(d => d.total >= 3 && d.closureRate < 70);

  // Recurring patterns (top repeated subjects)
  const recurringPatterns = useMemo(() => {
    const repeated = complaints.filter(c => c.isRepeated);
    const groups = groupBy(repeated, c => c.subject);
    return groups
      .map(g => ({ subject: g.key, count: g.items.length }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 5);
  }, [complaints]);

  // Delay reasons
  const delayReasons = useMemo(() => {
    const withReasons = complaints.filter(c => c.delayReason);
    const groups = groupBy(withReasons, c => c.delayReason as string);
    return groups
      .map(g => ({ reason: g.key, count: g.items.length }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 6);
  }, [complaints]);

  // Improvement opportunities
  const opportunities = useMemo(() => {
    const ops: { title: string; tone: "info" | "success" | "warning" | "danger" }[] = [];
    if (p && p.lateRate > 20) {
      ops.push({ title: `ارتفاع معدل التأخير إلى ${formatPercent(p.lateRate)} — يستوجب مراجعة آليات متابعة الإغلاق`, tone: "danger" });
    }
    if (p && p.avgFirstResponseHours > 48) {
      ops.push({ title: `متوسط زمن أول استجابة ${formatDuration(p.avgFirstResponseHours)} — يحتاج تحسين آليات الإحالة`, tone: "warning" });
    }
    if (a && a.missingFields > 0) {
      ops.push({ title: `${formatNumber(a.missingFields)} سجل يعاني من نقص في الحقول الأساسية — يلزم التدقيق عند الاستيراد`, tone: "warning" });
    }
    if (lowComplianceDepts.length > 0) {
      ops.push({ title: `${lowComplianceDepts.length} إدارة بمعدل إغلاق أقل من 70٪ — يستوجب تدخلاً إدارياً`, tone: "warning" });
    }
    if (p && p.satisfactionRate < 70) {
      ops.push({ title: `رضا المستفيدين منخفض (${formatPercent(p.satisfactionRate)}) — مراجعة جودة الحلول المقدّمة`, tone: "warning" });
    }
    if (recurringPatterns.length > 0) {
      ops.push({ title: `رصد ${recurringPatterns.length} نمط متكرر — معالجة الأسباب الجذرية لتقليل التكرار`, tone: "info" });
    }
    if (ops.length === 0) {
      ops.push({ title: "الأداء العام ضمن المعدلات المقبولة، يُوصى بالاستمرار في ممارسات المراقبة الحالية", tone: "success" });
    }
    return ops;
  }, [p, a, lowComplianceDepts, recurringPatterns]);

  return (
    <div className="space-y-6">
      <ReportCover
        title="التقرير التنفيذي"
        subtitle="نظرة شاملة على مؤشرات الشكاوى والأداء العام"
        period={period}
        scope={scope}
        generatedAt={generatedAt}
        icon={FileText}
        color="from-emerald-600 to-teal-700"
      />

      {/* Key changes summary */}
      {indicators.performance && t && (
        <section>
          <SectionTitle icon={Activity} title="ملخص التغيرات الرئيسية" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="إجمالي الشكاوى" value={formatNumber(v?.total || 0)} icon={ClipboardList} tone="info" />
            <KpiCard
              label="مقارنة بالفترة السابقة"
              value={t.growthRate !== null ? `${t.growthRate > 0 ? "+" : ""}${t.growthRate}%` : "—"}
              sub={t.previousTotal !== null ? `السابقة: ${formatNumber(t.previousTotal)}` : undefined}
              icon={t.growthRate !== null && t.growthRate > 0 ? TrendingUp : TrendingDown}
              tone={t.growthRate !== null && t.growthRate > 0 ? "danger" : "success"}
            />
            <KpiCard label="معدل الإغلاق" value={formatPercent(p?.closureRate || 0)} icon={CheckCircle2} tone="success" />
            <KpiCard label="نسبة الالتزام بالمواعيد" value={formatPercent(p?.onTimeRate || 0)} icon={Target} tone="info" />
          </div>
        </section>
      )}

      {/* Volume summary */}
      {indicators.volume && (
        <section>
          <SectionTitle icon={Layers} title="ملخص أحجام الشكاوى" />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="الإجمالي" value={formatNumber(v?.total || 0)} tone="info" />
            <KpiCard label="مفتوحة" value={formatNumber(v?.open || 0)} tone="warning" />
            <KpiCard label="قيد المعالجة" value={formatNumber(v?.inProgress || 0)} tone="warning" />
            <KpiCard label="مغلقة" value={formatNumber(v?.closed || 0)} tone="success" />
            <KpiCard label="متأخرة" value={formatNumber(v?.late || 0)} tone="danger" />
            <KpiCard label="معاد فتحها" value={formatNumber(v?.reopened || 0)} tone="danger" />
          </div>
        </section>
      )}

      {/* Top classifications */}
      {indicators.classifications && dashboard && (
        <section>
          <SectionTitle icon={PieChart} title="أبرز التصنيفات" />
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">#</TableHead>
                  <TableHead>التصنيف</TableHead>
                  <TableHead className="text-left w-24">العدد</TableHead>
                  <TableHead className="text-left w-32">النسبة</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.distributions.byClassification.slice(0, 5).map((c, i) => (
                  <TableRow key={c.name}>
                    <TableCell className="font-mono text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-left tabular-nums">{formatNumber(c.count)}</TableCell>
                    <TableCell className="text-left">
                      <div className="flex items-center gap-2">
                        <Progress value={pct(c.count, v?.total || 1)} className="h-2 w-20" />
                        <span className="text-xs text-muted-foreground tabular-nums w-12">
                          {formatPercent(pct(c.count, v?.total || 1))}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </section>
      )}

      {/* Top regions */}
      {indicators.regions && dashboard && (
        <section>
          <SectionTitle icon={MapPin} title="أبرز المناطق" />
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">#</TableHead>
                  <TableHead>المنطقة</TableHead>
                  <TableHead className="text-left w-24">العدد</TableHead>
                  <TableHead className="text-left w-32">الحصة</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.distributions.byRegion.slice(0, 5).map((r, i) => (
                  <TableRow key={r.name}>
                    <TableCell className="font-mono text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-left tabular-nums">{formatNumber(r.count)}</TableCell>
                    <TableCell className="text-left">
                      <div className="flex items-center gap-2">
                        <Progress value={pct(r.count, v?.total || 1)} className="h-2 w-20" />
                        <span className="text-xs text-muted-foreground tabular-nums w-12">
                          {formatPercent(pct(r.count, v?.total || 1))}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </section>
      )}

      {/* Critical & late complaints */}
      {indicators.critical && a && (
        <section>
          <SectionTitle icon={ShieldAlert} title="الشكاوى الحرجة والمتأخرة" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="شكاوى حرجة" value={formatNumber(a.criticalComplaints)} icon={ShieldAlert} tone="danger" />
            <KpiCard label="حرجة متأخرة" value={formatNumber(a.lateCritical)} icon={AlertTriangle} tone="danger" />
            <KpiCard label="إجمالي المتأخرات" value={formatNumber(v?.late || 0)} icon={Clock} tone="warning" />
            <KpiCard label="متأخرة دون إجراء" value={formatNumber(p?.overdueNoAction || 0)} icon={XCircle} tone="danger" />
          </div>
        </section>
      )}

      {/* Low compliance departments */}
      {indicators.compliance && (
        <section>
          <SectionTitle
            icon={Building2}
            title="إدارات ذات امتثال منخفض"
            action={lowComplianceDepts.length > 0 && (
              <Badge variant="destructive">{lowComplianceDepts.length} إدارة</Badge>
            )}
          />
          {lowComplianceDepts.length === 0 ? (
            <InsightBox tone="success">
              <CheckCircle2 className="h-4 w-4 inline-block ml-2" />
              جميع الإدارات تتجاوز معدل الإغلاق 70٪ خلال الفترة المحددة
            </InsightBox>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الإدارة</TableHead>
                    <TableHead className="text-left">إجمالي</TableHead>
                    <TableHead className="text-left">مغلقة</TableHead>
                    <TableHead className="text-left">متأخرة</TableHead>
                    <TableHead className="text-left">معدل الإغلاق</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lowComplianceDepts.map(d => (
                    <TableRow key={d.name}>
                      <TableCell className="font-medium">{d.name}</TableCell>
                      <TableCell className="text-left tabular-nums">{formatNumber(d.total)}</TableCell>
                      <TableCell className="text-left tabular-nums">{formatNumber(d.closed)}</TableCell>
                      <TableCell className="text-left tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(d.late)}</TableCell>
                      <TableCell className="text-left">
                        <span className="text-rose-600 dark:text-rose-400 font-semibold tabular-nums">
                          {formatPercent(d.closureRate)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </section>
      )}

      {/* Recurring patterns */}
      {indicators.recurring && (
        <section>
          <SectionTitle icon={RefreshCw} title="الأنماط المتكررة" />
          {recurringPatterns.length === 0 ? (
            <InsightBox tone="success">
              <CheckCircle2 className="h-4 w-4 inline-block ml-2" />
              لا توجد شكاوى متكررة خلال الفترة المحددة
            </InsightBox>
          ) : (
            <div className="grid gap-2">
              {recurringPatterns.map((rp, i) => (
                <div key={rp.subject} className="flex items-center gap-3 rounded-lg border p-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 font-bold text-sm shrink-0">
                    {i + 1}
                  </span>
                  <span className="font-medium flex-1 truncate">{rp.subject}</span>
                  <Badge variant="secondary">{formatNumber(rp.count)} تكرار</Badge>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Delay reasons */}
      {indicators.delays && (
        <section>
          <SectionTitle icon={Clock} title="أسباب التأخير" />
          {delayReasons.length === 0 ? (
            <InsightBox tone="success">
              <CheckCircle2 className="h-4 w-4 inline-block ml-2" />
              لا توجد أسباب تأخير مسجلة خلال الفترة
            </InsightBox>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>سبب التأخير</TableHead>
                    <TableHead className="text-left w-24">عدد الحالات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {delayReasons.map((d, i) => (
                    <TableRow key={d.reason}>
                      <TableCell className="font-mono text-muted-foreground">{i + 1}</TableCell>
                      <TableCell className="font-medium">{d.reason}</TableCell>
                      <TableCell className="text-left tabular-nums">{formatNumber(d.count)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </section>
      )}

      {/* Improvement opportunities */}
      {indicators.opportunities && (
        <section>
          <SectionTitle icon={Lightbulb} title="فرص التحسين" />
          <div className="grid gap-2">
            {opportunities.map((op, i) => (
              <InsightBox key={i} tone={op.tone}>
                <Lightbulb className="h-4 w-4 inline-block ml-2" />
                {op.title}
              </InsightBox>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// =========================================================================
// 2. Regional Performance Report
// =========================================================================

function RegionalReport({ report }: { report: ReportViewProps["report"] }) {
  const { config, complaints, dashboard, generatedAt } = report;
  const indicators = config.indicators;
  const period = formatRange(config.from, config.to);
  const scope = scopeText(config);

  const regionStats = useMemo(() => {
    const groups = groupBy(complaints, c => c.region?.name || "غير محدد");
    return groups.map(g => {
      const total = g.items.length;
      const open = g.items.filter(c => c.status === "open" || c.status === "in_progress").length;
      const closed = g.items.filter(c => c.status === "closed").length;
      const late = g.items.filter(isLateComplaint).length;
      const closedOnTime = g.items.filter(c =>
        c.status === "closed" && c.closureDate && c.dueDate &&
        new Date(c.closureDate) <= new Date(c.dueDate)
      ).length;
      const onTimeRate = pct(closedOnTime, closed);
      const processingTimes = g.items
        .filter(c => c.firstActionDate && c.closureDate)
        .map(c => (new Date(c.closureDate!).getTime() - new Date(c.firstActionDate!).getTime()) / (1000 * 60 * 60));
      const avgProcessing = processingTimes.length > 0
        ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length : 0;
      // top classification
      const classGroups = groupBy(g.items, c => c.classification?.name || "غير مصنف");
      const topClass = classGroups.sort((x, y) => y.items.length - x.items.length)[0];
      return {
        name: g.key, total, open, closed, late,
        onTimeRate, avgProcessing,
        topClassification: topClass ? `${topClass.key} (${topClass.items.length})` : "—",
      };
    }).sort((x, y) => y.total - x.total);
  }, [complaints]);

  const bestRegion = [...regionStats].sort((a, b) => b.onTimeRate - a.onTimeRate)[0];
  const worstRegion = [...regionStats].sort((a, b) => a.onTimeRate - b.onTimeRate)[0];
  const highLoadRegion = regionStats[0];

  return (
    <div className="space-y-6">
      <ReportCover
        title="تقرير أداء المناطق"
        subtitle="تحليل أداء المناطق الصحية في معالجة الشكاوى"
        period={period}
        scope={scope}
        generatedAt={generatedAt}
        icon={FileBarChart}
        color="from-sky-600 to-cyan-700"
      />

      {/* Highlights */}
      {indicators.highlights && (
        <section>
          <SectionTitle icon={Sparkles} title="نقاط بارزة" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {highLoadRegion && (
              <KpiCard
                label="أعلى أحمال"
                value={highLoadRegion.name}
                sub={`${formatNumber(highLoadRegion.total)} شكوى`}
                icon={Layers}
                tone="info"
              />
            )}
            {bestRegion && (
              <KpiCard
                label="أعلى التزام بالمواعيد"
                value={bestRegion.name}
                sub={`${formatPercent(bestRegion.onTimeRate)} التزام`}
                icon={CheckCircle2}
                tone="success"
              />
            )}
            {worstRegion && (
              <KpiCard
                label="الأقل التزاماً"
                value={worstRegion.name}
                sub={`${formatPercent(worstRegion.onTimeRate)} التزام`}
                icon={AlertTriangle}
                tone="danger"
              />
            )}
          </div>
        </section>
      )}

      {/* Per-region table */}
      <section>
        <SectionTitle icon={MapPin} title="جدول أداء المناطق" />
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>المنطقة</TableHead>
                <TableHead className="text-left">الإجمالي</TableHead>
                <TableHead className="text-left">مفتوحة</TableHead>
                <TableHead className="text-left">مغلقة</TableHead>
                <TableHead className="text-left">متأخرة</TableHead>
                {indicators.ontime && <TableHead className="text-left">نسبة الالتزام</TableHead>}
                {indicators.processing && <TableHead className="text-left">متوسط المعالجة</TableHead>}
                {indicators.classifications && <TableHead>أبرز تصنيف</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {regionStats.map(r => (
                <TableRow key={r.name}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-left tabular-nums font-semibold">{formatNumber(r.total)}</TableCell>
                  <TableCell className="text-left tabular-nums text-amber-600 dark:text-amber-400">{formatNumber(r.open)}</TableCell>
                  <TableCell className="text-left tabular-nums text-emerald-600 dark:text-emerald-400">{formatNumber(r.closed)}</TableCell>
                  <TableCell className="text-left tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(r.late)}</TableCell>
                  {indicators.ontime && (
                    <TableCell className="text-left">
                      <span className={`font-semibold tabular-nums ${
                        r.onTimeRate >= 80 ? "text-emerald-600 dark:text-emerald-400" :
                        r.onTimeRate >= 60 ? "text-amber-600 dark:text-amber-400" :
                        "text-rose-600 dark:text-rose-400"
                      }`}>
                        {formatPercent(r.onTimeRate)}
                      </span>
                    </TableCell>
                  )}
                  {indicators.processing && (
                    <TableCell className="text-left tabular-nums">{formatDuration(r.avgProcessing)}</TableCell>
                  )}
                  {indicators.classifications && (
                    <TableCell className="text-sm text-muted-foreground">{r.topClassification}</TableCell>
                  )}
                </TableRow>
              ))}
              {regionStats.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                    لا توجد بيانات كافية في الفترة المحددة
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </section>

      {/* On-time rate visual */}
      {indicators.ontime && regionStats.length > 0 && (
        <section>
          <SectionTitle icon={Target} title="نسبة الالتزام بالمواعيد حسب المنطقة" />
          <div className="grid gap-2">
            {regionStats.map(r => (
              <div key={r.name} className="flex items-center gap-3">
                <div className="w-28 text-sm font-medium truncate shrink-0">{r.name}</div>
                <Progress
                  value={r.onTimeRate}
                  className={`h-3 flex-1 ${
                    r.onTimeRate >= 80 ? "[&>div]:bg-emerald-500" :
                    r.onTimeRate >= 60 ? "[&>div]:bg-amber-500" :
                    "[&>div]:bg-rose-500"
                  }`}
                />
                <div className="w-16 text-left text-sm font-semibold tabular-nums shrink-0">
                  {formatPercent(r.onTimeRate)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// =========================================================================
// 3. Department Performance Report
// =========================================================================

function DepartmentalReport({ report }: { report: ReportViewProps["report"] }) {
  const { config, complaints, generatedAt } = report;
  const indicators = config.indicators;
  const period = formatRange(config.from, config.to);
  const scope = scopeText(config);

  const deptStats = useMemo(() => {
    const groups = groupBy(complaints, c => c.department?.name || "غير محدد");
    return groups.map(g => {
      const assigned = g.items.length;
      const completed = g.items.filter(c => c.status === "closed").length;
      const late = g.items.filter(isLateComplaint).length;
      const firstActions = g.items
        .filter(c => c.referralDate && c.firstActionDate)
        .map(c => (new Date(c.firstActionDate!).getTime() - new Date(c.referralDate!).getTime()) / (1000 * 60 * 60));
      const avgFirstAction = firstActions.length > 0 ? firstActions.reduce((a, b) => a + b, 0) / firstActions.length : 0;
      const closures = g.items
        .filter(c => c.firstActionDate && c.closureDate)
        .map(c => (new Date(c.closureDate!).getTime() - new Date(c.firstActionDate!).getTime()) / (1000 * 60 * 60));
      const avgClosure = closures.length > 0 ? closures.reduce((a, b) => a + b, 0) / closures.length : 0;
      const reasonGroups = groupBy(
        g.items.filter(c => c.delayReason),
        c => c.delayReason as string
      );
      const topReason = reasonGroups.sort((x, y) => y.items.length - x.items.length)[0];
      // trend by week
      const trend = computeTrend(g.items);
      return {
        name: g.key, assigned, completed, late,
        avgFirstAction, avgClosure,
        topReason: topReason ? `${topReason.key} (${topReason.items.length})` : "—",
        trend,
      };
    }).sort((x, y) => y.assigned - x.assigned);
  }, [complaints]);

  const topDept = [...deptStats].sort((a, b) => pct(b.completed, b.assigned) - pct(a.completed, a.assigned))[0];
  const lowDept = [...deptStats].sort((a, b) => pct(a.completed, a.assigned) - pct(b.completed, b.assigned))[0];

  // Aggregate delay reasons
  const allDelayReasons = useMemo(() => {
    const groups = groupBy(complaints.filter(c => c.delayReason), c => c.delayReason as string);
    return groups
      .map(g => ({ reason: g.key, count: g.items.length }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 5);
  }, [complaints]);

  return (
    <div className="space-y-6">
      <ReportCover
        title="تقرير أداء الإدارات"
        subtitle="تقييم أداء الإدارات في معالجة الشكاوى"
        period={period}
        scope={scope}
        generatedAt={generatedAt}
        icon={FileSpreadsheet}
        color="from-violet-600 to-purple-700"
      />

      {/* Highlights */}
      <section>
        <SectionTitle icon={Sparkles} title="نقاط بارزة" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {topDept && (
            <KpiCard
              label="الأعلى إنجازاً"
              value={topDept.name}
              sub={`${formatPercent(pct(topDept.completed, topDept.assigned))} إنجاز`}
              icon={CheckCircle2}
              tone="success"
            />
          )}
          {lowDept && (
            <KpiCard
              label="الأقل إنجازاً"
              value={lowDept.name}
              sub={`${formatPercent(pct(lowDept.completed, lowDept.assigned))} إنجاز`}
              icon={AlertTriangle}
              tone="danger"
            />
          )}
          <KpiCard
            label="إجمالي الإدارات النشطة"
            value={formatNumber(deptStats.length)}
            sub={`${formatNumber(complaints.length)} شكوى`}
            icon={Building2}
            tone="info"
          />
        </div>
      </section>

      {/* Per-department table */}
      <section>
        <SectionTitle icon={Building2} title="جدول أداء الإدارات" />
        <Card>
          <ScrollArea className="max-h-[600px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>الإدارة</TableHead>
                  {indicators.assignments && <TableHead className="text-left">إحالات</TableHead>}
                  {indicators.completion && <TableHead className="text-left">منجزة</TableHead>}
                  {indicators.late && <TableHead className="text-left">متأخرة</TableHead>}
                  {indicators.response && <TableHead className="text-left">أول إجراء</TableHead>}
                  {indicators.closure && <TableHead className="text-left">الإغلاق</TableHead>}
                  {indicators.delays && <TableHead>أبرز سبب تأخير</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {deptStats.map(d => (
                  <TableRow key={d.name}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    {indicators.assignments && (
                      <TableCell className="text-left tabular-nums font-semibold">{formatNumber(d.assigned)}</TableCell>
                    )}
                    {indicators.completion && (
                      <TableCell className="text-left tabular-nums text-emerald-600 dark:text-emerald-400">{formatNumber(d.completed)}</TableCell>
                    )}
                    {indicators.late && (
                      <TableCell className="text-left tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(d.late)}</TableCell>
                    )}
                    {indicators.response && (
                      <TableCell className="text-left tabular-nums">{formatDuration(d.avgFirstAction)}</TableCell>
                    )}
                    {indicators.closure && (
                      <TableCell className="text-left tabular-nums">{formatDuration(d.avgClosure)}</TableCell>
                    )}
                    {indicators.delays && (
                      <TableCell className="text-sm text-muted-foreground">{d.topReason}</TableCell>
                    )}
                  </TableRow>
                ))}
                {deptStats.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                      لا توجد بيانات في الفترة المحددة
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </Card>
      </section>

      {/* Trend per department */}
      {indicators.trend && deptStats.length > 0 && (
        <section>
          <SectionTitle icon={BarChart3} title="الاتجاه الزمني للإدارات (آخر 8 أسابيع)" />
          <Card>
            <ScrollArea className="max-h-[400px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الإدارة</TableHead>
                    {deptStats[0]?.trend.map((_, i) => (
                      <TableHead key={i} className="text-center text-xs w-16">أسبوع {i + 1}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deptStats.slice(0, 8).map(d => (
                    <TableRow key={d.name}>
                      <TableCell className="font-medium">{d.name}</TableCell>
                      {d.trend.map((count, i) => {
                        const max = Math.max(...d.trend, 1);
                        const intensity = count / max;
                        return (
                          <TableCell key={i} className="text-center">
                            <div
                              className="mx-auto h-6 rounded-sm flex items-center justify-center text-[10px] font-medium"
                              style={{
                                backgroundColor: count > 0
                                  ? `oklch(0.6 0.15 280 / ${0.15 + intensity * 0.65})`
                                  : "transparent",
                                color: intensity > 0.5 ? "white" : "inherit",
                              }}
                              title={`أسبوع ${i + 1}: ${count} شكوى`}
                            >
                              {count > 0 ? count : ""}
                            </div>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </Card>
        </section>
      )}

      {/* Aggregate delay reasons */}
      {indicators.delays && allDelayReasons.length > 0 && (
        <section>
          <SectionTitle icon={Clock} title="أبرز أسباب التأخير (عبر الإدارات)" />
          <div className="grid gap-2">
            {allDelayReasons.map((r, i) => {
              const maxCount = allDelayReasons[0].count;
              return (
                <div key={r.reason} className="flex items-center gap-3">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-400 text-xs font-bold shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium truncate">{r.reason}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{formatNumber(r.count)}</span>
                    </div>
                    <Progress value={pct(r.count, maxCount)} className="h-1.5" />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function computeTrend(complaints: ComplaintRow[]): number[] {
  // Group by week, last 8 weeks
  const now = new Date();
  const weeks: number[] = [];
  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date(now.getTime() - (i + 1) * 7 * 24 * 60 * 60 * 1000);
    const weekEnd = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const count = complaints.filter(c => {
      const d = new Date(c.receivedDate);
      return d >= weekStart && d < weekEnd;
    }).length;
    weeks.push(count);
  }
  return weeks;
}

// =========================================================================
// 4. Recurring Themes Report
// =========================================================================

function ThemesReport({ report }: { report: ReportViewProps["report"] }) {
  const { config, complaints, generatedAt } = report;
  const indicators = config.indicators;
  const period = formatRange(config.from, config.to);
  const scope = scopeText(config);

  const themes = useMemo(() => {
    // Group by subject
    const groups = groupBy(complaints, c => c.subject);
    return groups
      .map(g => {
        const count = g.items.length;
        const repeatedCount = g.items.filter(c => c.isRepeated).length;
        const repeatRate = pct(repeatedCount, count);
        // affected locations
        const locGroups = groupBy(g.items, c => c.location?.name || "غير محدد");
        const locations = locGroups.map(lg => lg.key).slice(0, 3).join("، ");
        const locCount = locGroups.length;
        const firstSeen = g.items
          .map(c => new Date(c.receivedDate))
          .sort((a, b) => a.getTime() - b.getTime())[0];
        const lastSeen = g.items
          .map(c => new Date(c.receivedDate))
          .sort((a, b) => b.getTime() - a.getTime())[0];
        // severity (max)
        const severities = g.items.map(c => c.severity);
        const maxSeverity = severities.includes("critical") ? "critical"
          : severities.includes("high") ? "high"
          : severities.includes("medium") ? "medium" : "low";
        // root cause status (if any has delayReason or resolution)
        const hasRootCause = g.items.some(c => c.resolution || c.delayReason);
        const rootCauseStatus = hasRootCause
          ? (g.items.filter(c => c.resolution).length >= count / 2 ? "تمت المعالجة" : "قيد المعالجة")
          : "لم تتم المعالجة";
        return {
          subject: g.key, count, repeatRate, locations, locCount,
          firstSeen, lastSeen, maxSeverity, rootCauseStatus,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
  }, [complaints]);

  const severityTone = (s: string) => {
    if (s === "critical") return "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400";
    if (s === "high") return "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400";
    if (s === "medium") return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400";
    return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  };

  const rootCauseTone = (s: string) => {
    if (s === "تمت المعالجة") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400";
    if (s === "قيد المعالجة") return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400";
    return "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400";
  };

  return (
    <div className="space-y-6">
      <ReportCover
        title="تقرير الموضوعات المتكررة"
        subtitle="رصد وتحليل الموضوعات الأكثر تكراراً وحالة معالجتها"
        period={period}
        scope={scope}
        generatedAt={generatedAt}
        icon={FileCheck}
        color="from-amber-600 to-orange-700"
      />

      {/* Summary stats */}
      <section>
        <SectionTitle icon={Activity} title="ملخص الموضوعات" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="إجمالي الموضوعات" value={formatNumber(themes.length)} icon={Layers} tone="info" />
          <KpiCard label="موضوعات متكررة" value={formatNumber(themes.filter(t => t.repeatRate > 0).length)} icon={RefreshCw} tone="warning" />
          <KpiCard
            label="أعلى معدل تكرار"
            value={themes[0] ? formatPercent(themes[0].repeatRate) : "—"}
            sub={themes[0]?.subject}
            icon={TrendingUp}
            tone="danger"
          />
          <KpiCard
            label="معالَجة جذرياً"
            value={formatNumber(themes.filter(t => t.rootCauseStatus === "تمت المعالجة").length)}
            icon={CheckCircle2}
            tone="success"
          />
        </div>
      </section>

      {/* Themes table */}
      <section>
        <SectionTitle icon={Layers} title="جدول الموضوعات المتكررة" />
        <Card>
          <ScrollArea className="max-h-[600px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">#</TableHead>
                  <TableHead>الموضوع</TableHead>
                  {indicators.rate && <TableHead className="text-left">العدد</TableHead>}
                  {indicators.rate && <TableHead className="text-left">معدل التكرار</TableHead>}
                  {indicators.locations && <TableHead>المواقع المتأثرة</TableHead>}
                  {indicators.firstlast && <TableHead className="text-left">أول ظهور</TableHead>}
                  {indicators.firstlast && <TableHead className="text-left">آخر ظهور</TableHead>}
                  {indicators.severity && <TableHead className="text-left">الخطورة</TableHead>}
                  {indicators.rootcause && <TableHead className="text-left">السبب الجذري</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {themes.map((t, i) => (
                  <TableRow key={t.subject}>
                    <TableCell className="font-mono text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium max-w-xs">
                      <div className="truncate" title={t.subject}>{t.subject}</div>
                    </TableCell>
                    {indicators.rate && (
                      <TableCell className="text-left tabular-nums font-semibold">{formatNumber(t.count)}</TableCell>
                    )}
                    {indicators.rate && (
                      <TableCell className="text-left">
                        <Badge variant={t.repeatRate > 50 ? "destructive" : t.repeatRate > 0 ? "secondary" : "outline"}>
                          {formatPercent(t.repeatRate)}
                        </Badge>
                      </TableCell>
                    )}
                    {indicators.locations && (
                      <TableCell className="text-sm text-muted-foreground max-w-xs">
                        <div className="truncate" title={t.locations}>{t.locations}</div>
                        <span className="text-xs">{formatNumber(t.locCount)} موقع</span>
                      </TableCell>
                    )}
                    {indicators.firstlast && (
                      <TableCell className="text-left text-sm tabular-nums">{formatDate(t.firstSeen)}</TableCell>
                    )}
                    {indicators.firstlast && (
                      <TableCell className="text-left text-sm tabular-nums">{formatDate(t.lastSeen)}</TableCell>
                    )}
                    {indicators.severity && (
                      <TableCell className="text-left">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${severityTone(t.maxSeverity)}`}>
                          {severityLabel(t.maxSeverity)}
                        </span>
                      </TableCell>
                    )}
                    {indicators.rootcause && (
                      <TableCell className="text-left">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${rootCauseTone(t.rootCauseStatus)}`}>
                          {t.rootCauseStatus}
                        </span>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {themes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                      لا توجد موضوعات في الفترة المحددة
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </Card>
      </section>
    </div>
  );
}

// =========================================================================
// 5. Time Comparison Report
// =========================================================================

function TimeComparisonReport({ report }: { report: ReportViewProps["report"] }) {
  const { config, dashboard: current, previousDashboard: previous, generatedAt } = report;
  const indicators = config.indicators;
  const period = formatRange(config.from, config.to);
  const prevRangeStr = (() => {
    const pr = previousRange(config.from, config.to);
    return formatRange(pr.from, pr.to);
  })();
  const scope = scopeText(config);

  const cur = current;
  const prev = previous;
  const hasPrev = !!prev;

  // Compare classifications
  const classificationDeltas = useMemo(() => {
    if (!cur || !prev) return [];
    const curMap = new Map(cur.distributions.byClassification.map(c => [c.name, c.count]));
    const prevMap = new Map(prev.distributions.byClassification.map(c => [c.name, c.count]));
    const allNames = new Set([...curMap.keys(), ...prevMap.keys()]);
    return Array.from(allNames).map(name => {
      const c = curMap.get(name) || 0;
      const p = prevMap.get(name) || 0;
      const delta = c - p;
      const pctDelta = p > 0 ? Math.round(((c - p) / p) * 1000) / 10 : (c > 0 ? 100 : 0);
      return { name, current: c, previous: p, delta, pctDelta };
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [cur, prev]);

  const improvedClassifications = classificationDeltas.filter(d => d.delta < 0);
  const worsenedClassifications = classificationDeltas.filter(d => d.delta > 0);
  const exceptional = classificationDeltas.filter(d => Math.abs(d.pctDelta) >= 50 && (d.current > 0 || d.previous > 0));

  // Performance metrics comparison
  const perfCompare = useMemo(() => {
    if (!cur || !prev) return [];
    return [
      { label: "إجمالي الشكاوى", cur: cur.volume.total, prev: prev.volume.total, unit: "number" },
      { label: "مغلقة", cur: cur.volume.closed, prev: prev.volume.closed, unit: "number" },
      { label: "متأخرة", cur: cur.volume.late, prev: prev.volume.late, unit: "number" },
      { label: "معدل الإغلاق", cur: cur.performance.closureRate, prev: prev.performance.closureRate, unit: "percent" },
      { label: "نسبة الالتزام", cur: cur.performance.onTimeRate, prev: prev.performance.onTimeRate, unit: "percent" },
      { label: "متوسط أول استجابة (ساعة)", cur: cur.performance.avgFirstResponseHours, prev: prev.performance.avgFirstResponseHours, unit: "hours" },
      { label: "متوسط المعالجة (ساعة)", cur: cur.performance.avgProcessingHours, prev: prev.performance.avgProcessingHours, unit: "hours" },
      { label: "متوسط رضا المستفيدين", cur: cur.performance.avgSatisfaction, prev: prev.performance.avgSatisfaction, unit: "number" },
    ];
  }, [cur, prev]);

  return (
    <div className="space-y-6">
      <ReportCover
        title="تقرير المقارنة الزمنية"
        subtitle="مقارنة أداء الفترة الحالية بالفترة السابقة"
        period={period}
        scope={scope}
        generatedAt={generatedAt}
        icon={FileWarning}
        color="from-rose-600 to-pink-700"
      />

      {/* Periods comparison banner */}
      <section>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="border-rose-200 dark:border-rose-900">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 text-xs">حالي</span>
                الفترة الحالية
              </CardTitle>
              <CardDescription>{period}</CardDescription>
            </CardHeader>
          </Card>
          <Card className="border-slate-200 dark:border-slate-800">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs">سابق</span>
                الفترة السابقة
              </CardTitle>
              <CardDescription>{hasPrev ? prevRangeStr : "غير متاح"}</CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>

      {!hasPrev ? (
        <InsightBox tone="warning">
          <AlertTriangle className="h-4 w-4 inline-block ml-2" />
          لا يمكن جلب بيانات الفترة السابقة. تأكد من تحديد نطاق زمني صحيح.
        </InsightBox>
      ) : (
        <>
          {/* Performance comparison */}
          {indicators.performance && (
            <section>
              <SectionTitle icon={Activity} title="مقارنة المؤشرات الرئيسية" />
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>المؤشر</TableHead>
                      <TableHead className="text-left">السابقة</TableHead>
                      <TableHead className="text-left">الحالية</TableHead>
                      <TableHead className="text-left">التغير</TableHead>
                      <TableHead className="text-left">الاتجاه</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {perfCompare.map(row => {
                      const delta = row.cur - row.prev;
                      const pctDelta = row.prev > 0 ? Math.round((delta / row.prev) * 1000) / 10 : 0;
                      // For positive metrics (closure rate, on time), increase is good
                      const positiveIsGood = ["معدل الإغلاق", "نسبة الالتزام", "متوسط رضا المستفيدين", "مغلقة"].includes(row.label);
                      const isGood = positiveIsGood ? delta > 0 : delta < 0;
                      const isNeutral = delta === 0;
                      const fmtVal = (v: number) => {
                        if (row.unit === "percent") return formatPercent(v);
                        if (row.unit === "hours") return formatDuration(v);
                        return formatNumber(v);
                      };
                      return (
                        <TableRow key={row.label}>
                          <TableCell className="font-medium">{row.label}</TableCell>
                          <TableCell className="text-left tabular-nums text-muted-foreground">{fmtVal(row.prev)}</TableCell>
                          <TableCell className="text-left tabular-nums font-semibold">{fmtVal(row.cur)}</TableCell>
                          <TableCell className="text-left">
                            <span className={`tabular-nums font-semibold ${
                              isNeutral ? "text-muted-foreground" :
                              isGood ? "text-emerald-600 dark:text-emerald-400" :
                              "text-rose-600 dark:text-rose-400"
                            }`}>
                              {delta > 0 ? "+" : ""}{row.unit === "percent" ? `${pctDelta}%` : fmtVal(Math.abs(delta))}
                            </span>
                          </TableCell>
                          <TableCell className="text-left">
                            {isNeutral ? (
                              <Badge variant="outline"><Minus className="h-3 w-3" />ثابت</Badge>
                            ) : isGood ? (
                              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900">
                                <TrendingUp className="h-3 w-3" />تحسن
                              </Badge>
                            ) : (
                              <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400 border-rose-200 dark:border-rose-900">
                                <TrendingDown className="h-3 w-3" />تراجع
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Card>
            </section>
          )}

          {/* Classifications comparison */}
          {indicators.classifications && (
            <section>
              <SectionTitle icon={PieChart} title="تحسن وتراجع التصنيفات" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Improved */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <TrendingDown className="h-4 w-4 text-emerald-600" />
                      تصنيفات تحسّنت (انخفاض)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {improvedClassifications.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">لا يوجد تحسن ملحوظ</p>
                    ) : (
                      <div className="space-y-2">
                        {improvedClassifications.slice(0, 5).map(c => (
                          <div key={c.name} className="flex items-center justify-between gap-2 text-sm">
                            <span className="truncate">{c.name}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-xs text-muted-foreground tabular-nums">{formatNumber(c.previous)} ← {formatNumber(c.current)}</span>
                              <DeltaBadge value={-c.pctDelta} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
                {/* Worsened */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-rose-600" />
                      تصنيفات تراجعت (ارتفاع)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {worsenedClassifications.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">لا يوجد تراجع ملحوظ</p>
                    ) : (
                      <div className="space-y-2">
                        {worsenedClassifications.slice(0, 5).map(c => (
                          <div key={c.name} className="flex items-center justify-between gap-2 text-sm">
                            <span className="truncate">{c.name}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-xs text-muted-foreground tabular-nums">{formatNumber(c.previous)} ← {formatNumber(c.current)}</span>
                              <DeltaBadge value={c.pctDelta} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </section>
          )}

          {/* Exceptional changes */}
          {indicators.exceptions && (
            <section>
              <SectionTitle
                icon={Sparkles}
                title="تغيرات استثنائية (≥ 50%)"
                action={exceptional.length > 0 && <Badge variant="destructive">{exceptional.length} تغير</Badge>}
              />
              {exceptional.length === 0 ? (
                <InsightBox tone="success">
                  <CheckCircle2 className="h-4 w-4 inline-block ml-2" />
                  لا توجد تغيرات استثنائية في التصنيفات بين الفترتين
                </InsightBox>
              ) : (
                <div className="grid gap-2">
                  {exceptional.map(c => (
                    <InsightBox
                      key={c.name}
                      tone={c.delta > 0 ? "danger" : "success"}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{c.name}</span>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground tabular-nums">{formatNumber(c.previous)} ← {formatNumber(c.current)}</span>
                          <DeltaBadge value={c.pctDelta} />
                        </div>
                      </div>
                    </InsightBox>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

// =========================================================================
// 6. Data Quality Report
// =========================================================================

function DataQualityReport({ report }: { report: ReportViewProps["report"] }) {
  const { config, complaints, importBatches, generatedAt } = report;
  const indicators = config.indicators;
  const period = formatRange(config.from, config.to);
  const scope = scopeText(config);
  const total = complaints.length;

  // Missing fields breakdown
  const missingFields = useMemo(() => {
    const fields = [
      { key: "regionId", label: "المنطقة", count: complaints.filter(c => !c.regionId).length },
      { key: "departmentId", label: "الإدارة", count: complaints.filter(c => !c.departmentId).length },
      { key: "classificationId", label: "التصنيف", count: complaints.filter(c => !c.classificationId).length },
      { key: "locationId", label: "الموقع", count: complaints.filter(c => !c.locationId).length },
      { key: "dueDate", label: "تاريخ الاستحقاق", count: complaints.filter(c => !c.dueDate).length },
      { key: "referralDate", label: "تاريخ الإحالة", count: complaints.filter(c => !c.referralDate).length },
      { key: "description", label: "الوصف", count: complaints.filter(c => !c.description || c.description.trim() === "").length },
    ];
    return fields.filter(f => f.count > 0).sort((a, b) => b.count - a.count);
  }, [complaints]);

  // Duplicates
  const duplicates = complaints.filter(c => c.isPotentialDuplicate);

  // Illogical dates
  const illogicalDates = useMemo(() => {
    return complaints.filter(c => {
      const received = new Date(c.receivedDate);
      if (c.firstActionDate && new Date(c.firstActionDate) < received) return true;
      if (c.closureDate && c.firstActionDate && new Date(c.closureDate) < new Date(c.firstActionDate)) return true;
      if (c.closureDate && new Date(c.closureDate) < received) return true;
      if (c.dueDate && new Date(c.dueDate) < received) return true;
      return false;
    });
  }, [complaints]);

  // Unapproved statuses (e.g., open without firstAction for long time)
  const unapprovedStatuses = useMemo(() => {
    const now = new Date();
    return complaints.filter(c => {
      // Open cases older than 30 days without first action
      if ((c.status === "open" || c.status === "in_progress") && !c.firstActionDate) {
        const age = (now.getTime() - new Date(c.receivedDate).getTime()) / (1000 * 60 * 60 * 24);
        if (age > 30) return true;
      }
      // Reopened more than once
      if (c.status === "OPEN") return true;
      return false;
    });
  }, [complaints]);

  // Non-compliant entities (regions/departments with high late rate)
  const nonCompliantEntities = useMemo(() => {
    const deptGroups = groupBy(complaints, c => c.department?.name || "غير محدد");
    return deptGroups
      .map(g => {
        const total = g.items.length;
        const late = g.items.filter(isLateComplaint).length;
        const lateRate = pct(late, total);
        return { name: g.key, total, late, lateRate, type: "إدارة" };
      })
      .filter(d => d.total >= 3 && d.lateRate > 40)
      .sort((a, b) => b.lateRate - a.lateRate);
  }, [complaints]);

  // Unclassifiable records (no classification AND no AI classification)
  const unclassifiable = complaints.filter(c => !c.classificationId && !c.aiClassification);

  // Import batches not approved
  const unapprovedBatches = importBatches.filter(b => b.status !== "approved");

  const qualityScore = Math.max(0, 100 - (
    (missingFields.reduce((sum, f) => sum + f.count, 0) / Math.max(total, 1)) * 30 +
    (duplicates.length / Math.max(total, 1)) * 20 +
    (illogicalDates.length / Math.max(total, 1)) * 25 +
    (unclassifiable.length / Math.max(total, 1)) * 25
  ));

  return (
    <div className="space-y-6">
      <ReportCover
        title="تقرير جودة البيانات"
        subtitle="تدقيق جودة بيانات الشكاوى ورصد النواقص والمشكلات"
        period={period}
        scope={scope}
        generatedAt={generatedAt}
        icon={FileSearch}
        color="from-slate-600 to-zinc-700"
      />

      {/* Overall quality score */}
      <section>
        <SectionTitle icon={ShieldAlert} title="مؤشر جودة البيانات الإجمالي" />
        <Card>
          <CardContent className="pt-0">
            <div className="flex items-center gap-6">
              <div className="relative shrink-0">
                <div className="flex h-24 w-24 items-center justify-center rounded-full border-8"
                  style={{
                    borderColor: qualityScore >= 80 ? "oklch(0.6 0.15 160)" :
                      qualityScore >= 60 ? "oklch(0.7 0.18 50)" : "oklch(0.6 0.2 25)",
                  }}
                >
                  <div className="text-center">
                    <div className="text-2xl font-bold tabular-nums">{Math.round(qualityScore)}%</div>
                    <div className="text-[10px] text-muted-foreground">جودة</div>
                  </div>
                </div>
              </div>
              <div className="flex-1">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <KpiCard label="إجمالي السجلات" value={formatNumber(total)} icon={Database} tone="info" />
                  <KpiCard label="حقول مفقودة" value={formatNumber(missingFields.reduce((s, f) => s + f.count, 0))} icon={XCircle} tone="danger" />
                  <KpiCard label="تكرارات محتملة" value={formatNumber(duplicates.length)} icon={Layers} tone="warning" />
                  <KpiCard label="تواريخ غير منطقية" value={formatNumber(illogicalDates.length)} icon={AlertTriangle} tone="danger" />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Missing fields */}
      {indicators.missing && (
        <section>
          <SectionTitle icon={XCircle} title="الحقول المفقودة" />
          {missingFields.length === 0 ? (
            <InsightBox tone="success">
              <CheckCircle2 className="h-4 w-4 inline-block ml-2" />
              جميع السجلات تحتوي على الحقول الأساسية المطلوبة
            </InsightBox>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الحقل</TableHead>
                    <TableHead className="text-left">عدد السجلات الناقصة</TableHead>
                    <TableHead className="text-left">النسبة من الإجمالي</TableHead>
                    <TableHead className="text-left w-40">الانتشار</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {missingFields.map(f => (
                    <TableRow key={f.key}>
                      <TableCell className="font-medium">{f.label}</TableCell>
                      <TableCell className="text-left tabular-nums font-semibold text-rose-600 dark:text-rose-400">{formatNumber(f.count)}</TableCell>
                      <TableCell className="text-left tabular-nums">{formatPercent(pct(f.count, total))}</TableCell>
                      <TableCell className="text-left">
                        <Progress value={pct(f.count, total)} className="h-2 [&>div]:bg-rose-500" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </section>
      )}

      {/* Duplicates */}
      {indicators.duplicates && (
        <section>
          <SectionTitle icon={Layers} title="السجلات المكررة المحتملة" />
          {duplicates.length === 0 ? (
            <InsightBox tone="success">
              <CheckCircle2 className="h-4 w-4 inline-block ml-2" />
              لا توجد سجلات مكررة محتملة
            </InsightBox>
          ) : (
            <Card>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                  <KpiCard label="إجمالي المكررات" value={formatNumber(duplicates.length)} icon={Layers} tone="warning" />
                  <KpiCard label="نسبة التكرار" value={formatPercent(pct(duplicates.length, total))} icon={Activity} tone="warning" />
                  <KpiCard label="نسبة الجودة" value={formatPercent(100 - pct(duplicates.length, total))} icon={CheckCircle2} tone="success" />
                </div>
                <ScrollArea className="max-h-72">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>رقم الشكوى</TableHead>
                        <TableHead>الموضوع</TableHead>
                        <TableHead>تاريخ الاستلام</TableHead>
                        <TableHead className="text-left">الحالة</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {duplicates.slice(0, 20).map(c => (
                        <TableRow key={c.id}>
                          <TableCell className="font-mono text-xs">{c.complaintNumber}</TableCell>
                          <TableCell className="max-w-xs truncate" title={c.subject}>{c.subject}</TableCell>
                          <TableCell className="text-sm">{formatDate(c.receivedDate)}</TableCell>
                          <TableCell className="text-left">
                            <Badge variant="outline">{statusLabel(c.status)}</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          )}
        </section>
      )}

      {/* Illogical dates */}
      {indicators.illogical && (
        <section>
          <SectionTitle icon={AlertTriangle} title="التواريخ غير المنطقية" />
          {illogicalDates.length === 0 ? (
            <InsightBox tone="success">
              <CheckCircle2 className="h-4 w-4 inline-block ml-2" />
              جميع التواريخ متسقة منطقياً
            </InsightBox>
          ) : (
            <Card>
              <ScrollArea className="max-h-72">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>رقم الشكوى</TableHead>
                      <TableHead>الموضوع</TableHead>
                      <TableHead>تاريخ الاستلام</TableHead>
                      <TableHead>أول إجراء</TableHead>
                      <TableHead>الإغلاق</TableHead>
                      <TableHead className="text-left">المشكلة</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {illogicalDates.slice(0, 20).map(c => {
                      const issues: string[] = [];
                      const received = new Date(c.receivedDate);
                      if (c.firstActionDate && new Date(c.firstActionDate) < received) issues.push("إجراء قبل الاستلام");
                      if (c.closureDate && c.firstActionDate && new Date(c.closureDate) < new Date(c.firstActionDate)) issues.push("إغلاق قبل الإجراء");
                      if (c.closureDate && new Date(c.closureDate) < received) issues.push("إغلاق قبل الاستلام");
                      if (c.dueDate && new Date(c.dueDate) < received) issues.push("استحقاق قبل الاستلام");
                      return (
                        <TableRow key={c.id}>
                          <TableCell className="font-mono text-xs">{c.complaintNumber}</TableCell>
                          <TableCell className="max-w-xs truncate" title={c.subject}>{c.subject}</TableCell>
                          <TableCell className="text-sm">{formatDate(c.receivedDate)}</TableCell>
                          <TableCell className="text-sm">{c.firstActionDate ? formatDate(c.firstActionDate) : "—"}</TableCell>
                          <TableCell className="text-sm">{c.closureDate ? formatDate(c.closureDate) : "—"}</TableCell>
                          <TableCell className="text-left">
                            <Badge variant="destructive" className="text-xs">{issues.join("، ")}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </ScrollArea>
            </Card>
          )}
        </section>
      )}

      {/* Unapproved statuses */}
      {indicators.unapproved && (
        <section>
          <SectionTitle icon={Clock} title="الحالات غير المعتمدة / المتوقفة" />
          <Card>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                <KpiCard label="حالات متوقفة > 30 يوم" value={formatNumber(unapprovedStatuses.length)} icon={AlertTriangle} tone="warning" />
                <KpiCard label="دفعات استيراد غير معتمدة" value={formatNumber(unapprovedBatches.length)} icon={Database} tone="danger" />
                <KpiCard label="نسبة الاعتماد" value={formatPercent(pct(importBatches.length - unapprovedBatches.length, importBatches.length || 1))} icon={CheckCircle2} tone="info" />
              </div>
              {unapprovedBatches.length > 0 && (
                <>
                  <h4 className="text-sm font-semibold mb-2">دفعات الاستيراد غير المعتمدة:</h4>
                  <div className="space-y-2">
                    {unapprovedBatches.slice(0, 5).map(b => (
                      <div key={b.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileWarning className="h-4 w-4 text-amber-500 shrink-0" />
                          <span className="font-medium truncate">{b.fileName}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-xs text-muted-foreground tabular-nums">{formatNumber(b.totalRecords)} سجل</span>
                          <Badge variant={b.status === "pending" ? "secondary" : "outline"}>{b.status}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {unapprovedStatuses.length > 0 && (
                <>
                  <h4 className="text-sm font-semibold mb-2 mt-4">حالات شكاوى متوقفة:</h4>
                  <ScrollArea className="max-h-48">
                    <div className="space-y-1">
                      {unapprovedStatuses.slice(0, 10).map(c => (
                        <div key={c.id} className="flex items-center justify-between gap-3 rounded-md bg-muted/30 p-2 text-sm">
                          <span className="font-mono text-xs">{c.complaintNumber}</span>
                          <span className="truncate flex-1 text-muted-foreground">{c.subject}</span>
                          <Badge variant="outline">{statusLabel(c.status)}</Badge>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      {/* Non-compliant entities */}
      {indicators.noncompliant && (
        <section>
          <SectionTitle
            icon={Building2}
            title="الكيانات غير الملتزمة"
            action={nonCompliantEntities.length > 0 && <Badge variant="destructive">{nonCompliantEntities.length} كيان</Badge>}
          />
          {nonCompliantEntities.length === 0 ? (
            <InsightBox tone="success">
              <CheckCircle2 className="h-4 w-4 inline-block ml-2" />
              جميع الكيانات تلتزم بمعدلات تأخير مقبولة (أقل من 40٪)
            </InsightBox>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الكيان</TableHead>
                    <TableHead>النوع</TableHead>
                    <TableHead className="text-left">إجمالي الشكاوى</TableHead>
                    <TableHead className="text-left">المتأخرة</TableHead>
                    <TableHead className="text-left">معدل التأخير</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {nonCompliantEntities.map(e => (
                    <TableRow key={e.name}>
                      <TableCell className="font-medium">{e.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{e.type}</Badge>
                      </TableCell>
                      <TableCell className="text-left tabular-nums">{formatNumber(e.total)}</TableCell>
                      <TableCell className="text-left tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(e.late)}</TableCell>
                      <TableCell className="text-left">
                        <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                          {formatPercent(e.lateRate)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </section>
      )}

      {/* Unclassifiable records */}
      {indicators.unclassifiable && (
        <section>
          <SectionTitle
            icon={FileSearch}
            title="السجلات غير القابلة للتصنيف"
            action={unclassifiable.length > 0 && <Badge variant="destructive">{unclassifiable.length} سجل</Badge>}
          />
          {unclassifiable.length === 0 ? (
            <InsightBox tone="success">
              <CheckCircle2 className="h-4 w-4 inline-block ml-2" />
              جميع السجلات تم تصنيفها (يدوياً أو تلقائياً)
            </InsightBox>
          ) : (
            <Card>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                  <KpiCard label="عدد السجلات غير المصنفة" value={formatNumber(unclassifiable.length)} icon={FileSearch} tone="danger" />
                  <KpiCard label="النسبة من الإجمالي" value={formatPercent(pct(unclassifiable.length, total))} icon={Activity} tone="warning" />
                </div>
                <ScrollArea className="max-h-48">
                  <div className="space-y-1">
                    {unclassifiable.slice(0, 15).map(c => (
                      <div key={c.id} className="flex items-center justify-between gap-3 rounded-md bg-muted/30 p-2 text-sm">
                        <span className="font-mono text-xs">{c.complaintNumber}</span>
                        <span className="truncate flex-1 text-muted-foreground">{c.subject}</span>
                        <Badge variant="outline" className="text-rose-600 dark:text-rose-400">غير مصنف</Badge>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}
