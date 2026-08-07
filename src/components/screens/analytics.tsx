"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BarChart3, TrendingUp, TrendingDown, Calendar, Filter, Layers,
  GitCompare, AlertTriangle, Sparkles, Activity, RefreshCw,
  MapPin, Building2, Clock, CheckCircle2, Flame, Zap, ArrowLeft,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  ScatterChart, Scatter, ZAxis, Legend, ComposedChart,
} from "recharts";
import {
  formatNumber, formatPercent, formatDate, formatDuration,
  STATUS_LABELS, PRIORITY_LABELS,
} from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";
import {
  evaluateComparison,
  type ComparisonState,
} from "@/lib/analytics/comparison-evaluation";
import {
  apiErrorMessage,
  isAnalyticsData,
  isDashboardData,
  isRecord,
  readJsonResponse,
  type AnalyticsData,
  type DashboardData,
} from "@/lib/analytics/analytics-api-contract";
import { OperationalAnalyticsPanel } from "@/components/screens/operational-analytics-panel";

// ---------- Comparison helpers ----------

export function getComparisonStateClassName(state: ComparisonState): string {
  if (state === "INCREASE") return "text-red-600";
  if (state === "DECREASE") return "text-emerald-600";
  return "text-muted-foreground";
}

type ComparisonDirectionIconProps = Readonly<{
  state: ComparisonState;
}>;

function ComparisonDirectionIcon({ state }: ComparisonDirectionIconProps) {
  if (state === "INCREASE") return <TrendingUp className="h-3 w-3" />;
  if (state === "DECREASE") return <TrendingDown className="h-3 w-3" />;
  return null;
}

export function formatComparisonDifference(difference: number | null): string {
  if (difference === null) return "—";
  return `${difference > 0 ? "+" : ""}${formatNumber(difference)}`;
}

// ---------- Types ----------
// DashboardData / AnalyticsData live in analytics-api-contract.ts alongside
// the runtime guards that validate them — see isDashboardData/isAnalyticsData.
interface FilterOption { id: string; name: string; }

// ---------- Constants ----------
const CHART_COLORS = ["#0d9488", "#f59e0b", "#3b82f6", "#ef4444", "#a855f7", "#14b8a6", "#f97316", "#ec4899"];

const PERIOD_PRESETS = [
  { id: "7d", label: "آخر 7 أيام", days: 7 },
  { id: "30d", label: "آخر 30 يوم", days: 30 },
  { id: "90d", label: "آخر 90 يوم", days: 90 },
  { id: "180d", label: "آخر 180 يوم", days: 180 },
  { id: "365d", label: "آخر سنة", days: 365 },
];

const PRIORITY_ORDER = ["critical", "high", "medium", "low"];

// ---------- Arabic chart tooltip ----------
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-popover/95 backdrop-blur p-3 shadow-lg text-xs space-y-1.5 min-w-[160px]">
      {label && <p className="font-semibold text-foreground border-b pb-1.5 mb-1">{label}</p>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: p.color || p.fill }} />
            <span className="text-muted-foreground">{p.name}</span>
          </div>
          <span className="font-bold text-foreground tabular-nums">{formatNumber(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- Date helpers ----------
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return formatLocalDate(d);
}

function todayIso(): string {
  return formatLocalDate(new Date());
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateShort(d: string): string {
  try {
    const date = new Date(d);
    return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return d;
  }
}

// ---------- Main Component ----------
export function Analytics() {
  // Filter state
  const [from, setFrom] = useState<string>(daysAgoIso(90));
  const [to, setTo] = useState<string>(todayIso());
  const [regionId, setRegionId] = useState<string>("all");
  const [departmentId, setDepartmentId] = useState<string>("all");
  const [activePreset, setActivePreset] = useState<string>("90d");

  // Filter options
  const [regions, setRegions] = useState<FilterOption[]>([]);
  const [departments, setDepartments] = useState<FilterOption[]>([]);

  // Data
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filtersError, setFiltersError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("trends");
  const filterRequestRef = useRef(0);
  const dataRequestRef = useRef(0);

  // Load filter options once. A failure here must never crash the page and
  // must never mask the primary dashboard/analytics error — regions and
  // departments simply fall back to empty, safe arrays.
  useEffect(() => {
    const controller = new AbortController();
    const requestId = filterRequestRef.current + 1;
    filterRequestRef.current = requestId;
    const canUpdate = () => !controller.signal.aborted && filterRequestRef.current === requestId;

    (async () => {
      try {
        setFiltersError(null);
        const res = await fetch("/api/filters", { signal: controller.signal });
        const payload = await readJsonResponse(res);
        if (!res.ok) {
          throw new Error(apiErrorMessage(payload, "تعذر تحميل خيارات الفلاتر."));
        }
        const record = isRecord(payload) ? payload : {};
        const nextRegions: FilterOption[] = Array.isArray(record.regions) ? record.regions : [];
        const nextDepartments: FilterOption[] = Array.isArray(record.departments) ? record.departments : [];
        if (canUpdate()) {
          setRegions(nextRegions);
          setDepartments(nextDepartments);
        }
      } catch (e) {
        if (isAbortError(e)) return;
        if (canUpdate()) {
          setRegions([]);
          setDepartments([]);
          setFiltersError(e instanceof Error ? e.message : "تعذر تحميل خيارات الفلاتر.");
        }
        console.error("Filter options load failed:", e);
      }
    })();
    return () => {
      controller.abort();
    };
  }, []);

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (regionId && regionId !== "all") params.set("regionId", regionId);
    if (departmentId && departmentId !== "all") params.set("departmentId", departmentId);
    return params.toString();
  }, [from, to, regionId, departmentId]);

  const loadData = useCallback(async (signal?: AbortSignal) => {
    const requestId = dataRequestRef.current + 1;
    dataRequestRef.current = requestId;
    const canUpdate = () => !signal?.aborted && dataRequestRef.current === requestId;
    setLoading(true);
    setLoadError(null);
    const qs = buildQuery();
    let aborted = false;
    try {
      const [dashRes, anaRes] = await Promise.all([
        fetch(`/api/dashboard?${qs}`, { signal }),
        fetch(`/api/analytics?${qs}`, { signal }),
      ]);
      const [dashPayload, anaPayload] = await Promise.all([
        readJsonResponse(dashRes),
        readJsonResponse(anaRes),
      ]);

      if (!dashRes.ok) {
        throw new Error(apiErrorMessage(dashPayload, "تعذر جلب مؤشرات لوحة التحكم."));
      }
      if (!anaRes.ok) {
        throw new Error(apiErrorMessage(anaPayload, "تعذر جلب بيانات التحليلات."));
      }
      if (!isDashboardData(dashPayload)) {
        throw new Error("استجابة لوحة التحكم غير مكتملة.");
      }
      if (!isAnalyticsData(anaPayload)) {
        throw new Error("استجابة التحليلات غير مكتملة.");
      }

      // Atomic update: dashboard and analytics are only ever committed to
      // state together, after both responses succeeded and matched their
      // contract — insights and comparisons are built from both sources at
      // once, so a partial update would desynchronize them.
      if (canUpdate()) {
        setDashboard(dashPayload);
        setAnalytics(anaPayload);
        setLoadError(null);
      }
    } catch (e) {
      aborted = isAbortError(e);
      if (!aborted && canUpdate()) {
        const message = e instanceof Error ? e.message : "تعذر تحميل بيانات التحليلات.";
        setLoadError(message);
        console.error("Analytics data load failed:", e);
      }
    } finally {
      if (!aborted && canUpdate()) {
        setLoading(false);
      }
    }
  }, [buildQuery]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        void loadData(controller.signal);
      }
    });
    return () => {
      controller.abort();
    };
  }, [loadData]);

  const applyPreset = (presetId: string) => {
    const preset = PERIOD_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    setFrom(daysAgoIso(preset.days));
    setTo(todayIso());
    setActivePreset(presetId);
  };

  const handleDateChange = (newFrom: string, newTo: string) => {
    setFrom(newFrom);
    setTo(newTo);
    setActivePreset("");
  };

  // ---------- Derived data ----------
  const insights = useMemo(() => buildInsights(dashboard, analytics), [dashboard, analytics]);
  const comparisonData = useMemo(
    () => buildComparisonData(dashboard, analytics),
    [dashboard, analytics]
  );

  const v = dashboard?.volume;
  const p = dashboard?.performance;
  const t = dashboard?.trend;

  return (
    <div className="space-y-6">
      <PageHeader
        title="التحليلات"
        description="تحليل متعدد الأبعاد للشكاوى مع كشف الأنماط والمقارنات الزمنية"
        icon={<BarChart3 className="h-6 w-6" />}
        actions={
          <Button variant="outline" size="sm" onClick={() => void loadData()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            تحديث
          </Button>
        }
      />

      {/* ---------- Load error banner ---------- */}
      {/* Kept above the content rather than replacing it: if a previous
          successful load already populated dashboard/analytics, that data
          stays visible while this alert reports the latest failed refresh. */}
      {loadError !== null && (
        <Card className="border-destructive/50 bg-destructive/5" role="alert">
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">تعذر تحميل التحليلات</p>
              <p className="text-sm text-muted-foreground mt-0.5">{loadError}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void loadData()}
            >
              إعادة المحاولة
            </Button>
          </CardContent>
        </Card>
      )}

      {filtersError !== null && (
        <output className="block text-xs text-muted-foreground">
          {filtersError}
        </output>
      )}

      {/* ---------- Filter Bar ---------- */}
      <Card className="border-border/60">
        <CardContent className="p-4">
          <div className="flex flex-col gap-4">
            {/* Period presets */}
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground shrink-0">
                <Calendar className="h-4 w-4" />
                الفترة الزمنية
              </div>
              <div className="flex flex-wrap gap-2">
                {PERIOD_PRESETS.map(preset => (
                  <Button
                    key={preset.id}
                    size="sm"
                    variant={activePreset === preset.id ? "default" : "outline"}
                    onClick={() => applyPreset(preset.id)}
                    className="h-8"
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Date range + filters */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Filter className="h-3 w-3" /> من تاريخ
                </Label>
                <Input
                  type="date"
                  value={from}
                  onChange={e => handleDateChange(e.target.value, to)}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Filter className="h-3 w-3" /> إلى تاريخ
                </Label>
                <Input
                  type="date"
                  value={to}
                  onChange={e => handleDateChange(from, e.target.value)}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> المنطقة
                </Label>
                <Select value={regionId} onValueChange={setRegionId}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="كل المناطق" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">كل المناطق</SelectItem>
                    {regions.map(r => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Building2 className="h-3 w-3" /> الإدارة
                </Label>
                <Select value={departmentId} onValueChange={setDepartmentId}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="كل الإدارات" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">كل الإدارات</SelectItem>
                    {departments.map(d => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------- Insight Cards ---------- */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))
        ) : (
          insights.map((insight, i) => (
            <InsightCard key={i} insight={insight} />
          ))
        )}
      </div>

      {/* ---------- Tabs ---------- */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="h-auto flex-wrap bg-muted/60 p-1">
          <TabsTrigger value="trends" className="gap-1.5">
            <TrendingUp className="h-4 w-4" /> الاتجاهات الزمنية
          </TabsTrigger>
          <TabsTrigger value="comparison" className="gap-1.5">
            <GitCompare className="h-4 w-4" /> المقارنات
          </TabsTrigger>
          <TabsTrigger value="themes" className="gap-1.5">
            <Layers className="h-4 w-4" /> الموضوعات المتكررة
          </TabsTrigger>
          <TabsTrigger value="relations" className="gap-1.5">
            <Sparkles className="h-4 w-4" /> العلاقات
          </TabsTrigger>
          <TabsTrigger value="patterns" className="gap-1.5">
            <Activity className="h-4 w-4" /> كشف الأنماط
          </TabsTrigger>
          <TabsTrigger value="operational" className="gap-1.5">
            <Filter className="h-4 w-4" /> تشغيلي
          </TabsTrigger>
        </TabsList>

        {/* ===== Tab 1: Time Trends ===== */}
        <TabsContent value="trends" className="mt-4 space-y-4">
          {loading ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Skeleton className="h-80 lg:col-span-2 rounded-xl" />
              <Skeleton className="h-80 rounded-xl" />
            </div>
          ) : (
            <>
              {/* Growth banner */}
              {t?.growthRate !== null && t?.growthRate !== undefined && (
                <Card className={`border-l-4 ${t.growthRate > 0 ? "border-l-red-500 bg-red-50/40 dark:bg-red-950/10" : "border-l-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/10"}`}>
                  <CardContent className="flex items-center gap-4 py-4">
                    <div className={`flex h-12 w-12 items-center justify-center rounded-full ${t.growthRate > 0 ? "bg-red-100 dark:bg-red-900/40" : "bg-emerald-100 dark:bg-emerald-900/40"}`}>
                      {t.growthRate > 0
                        ? <TrendingUp className="h-6 w-6 text-red-600" />
                        : <TrendingDown className="h-6 w-6 text-emerald-600" />}
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold">
                        {t.growthRate > 0 ? "ارتفاع في حجم الشكاوى" : "انخفاض في حجم الشكاوى"}
                        {" بنسبة "}
                        <span className={t.growthRate > 0 ? "text-red-600" : "text-emerald-600"}>
                          {formatPercent(Math.abs(t.growthRate))}
                        </span>
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t.previousTotal !== null && (
                          <>الفترة السابقة: {formatNumber(t.previousTotal)} شكوى → الفترة الحالية: {formatNumber(v!.total)} شكوى</>
                        )}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Trend area chart */}
                <Card className="lg:col-span-2 card-hover">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-base">منحنى الشكاوى اليومي</CardTitle>
                        <CardDescription className="text-xs">إجمالي الشكاوى الواردة والمغلقة</CardDescription>
                      </div>
                      <Badge variant="outline" className="gap-1">
                        <Activity className="h-3 w-3" /> {t?.trendData.length || 0} يوم
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <AreaChart data={t?.trendData || []}>
                        <defs>
                          <linearGradient id="totalGradA" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#0d9488" stopOpacity={0.35} />
                            <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="closedGradA" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={formatDateShort} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip content={<ChartTooltip />} />
                        <Area type="monotone" dataKey="total" name="إجمالي الوارد" stroke="#0d9488" strokeWidth={2} fill="url(#totalGradA)" />
                        <Area type="monotone" dataKey="closed" name="المغلقة" stroke="#22c55e" strokeWidth={2} fill="url(#closedGradA)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Status distribution pie */}
                <Card className="card-hover">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">توزيع الحالات</CardTitle>
                    <CardDescription className="text-xs">حسب الحالة الحالية</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie
                          data={dashboard?.distributions.byStatus?.map(s => ({ name: STATUS_LABELS[s.name] || s.name, value: s.count })) || []}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={90}
                          innerRadius={50}
                          paddingAngle={2}
                        >
                          {(dashboard?.distributions.byStatus || []).map((_, i) => (
                            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip content={<ChartTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="grid grid-cols-2 gap-1.5 mt-3 text-xs">
                      {dashboard?.distributions.byStatus?.slice(0, 5).map((s, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                          <span className="text-muted-foreground truncate">{STATUS_LABELS[s.name] || s.name}</span>
                          <span className="font-bold mr-auto">{formatNumber(s.count)}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Severity & Priority radar */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card className="card-hover">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Flame className="h-4 w-4 text-orange-500" /> توزيع الأولويات والخطورة
                    </CardTitle>
                    <CardDescription className="text-xs">رسم راداري لمستويات الأولوية والخطورة</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={280}>
                      <RadarChart data={[
                        { subject: "حرجة", priority: dashboard?.distributions.byPriority.find(p => p.name === "critical")?.count || 0, severity: dashboard?.distributions.bySeverity.find(s => s.name === "critical")?.count || 0 },
                        { subject: "عالية", priority: dashboard?.distributions.byPriority.find(p => p.name === "high")?.count || 0, severity: dashboard?.distributions.bySeverity.find(s => s.name === "high")?.count || 0 },
                        { subject: "متوسطة", priority: dashboard?.distributions.byPriority.find(p => p.name === "medium")?.count || 0, severity: dashboard?.distributions.bySeverity.find(s => s.name === "medium")?.count || 0 },
                        { subject: "منخفضة", priority: dashboard?.distributions.byPriority.find(p => p.name === "low")?.count || 0, severity: dashboard?.distributions.bySeverity.find(s => s.name === "low")?.count || 0 },
                      ]}>
                        <PolarGrid stroke="#e2e8f0" />
                        <PolarAngleAxis dataKey="subject" tick={{ fontSize: 12 }} />
                        <PolarRadiusAxis tick={{ fontSize: 10 }} />
                        <Radar name="الأولوية" dataKey="priority" stroke="#0d9488" fill="#0d9488" fillOpacity={0.4} />
                        <Radar name="الخطورة" dataKey="severity" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.4} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                      </RadarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                <Card className="card-hover">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">الاتجاه التراكمي</CardTitle>
                    <CardDescription className="text-xs">العدد التراكمي للشكاوى الواردة والمغلقة</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={buildCumulative(t?.trendData || [])}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={formatDateShort} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Line type="monotone" dataKey="cumulativeTotal" name="تراكمي الوارد" stroke="#0d9488" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="cumulativeClosed" name="تراكمي المغلقة" stroke="#22c55e" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        {/* ===== Tab 2: Comparison ===== */}
        <TabsContent value="comparison" className="mt-4 space-y-4">
          {loading ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Skeleton className="h-96 rounded-xl" />
              <Skeleton className="h-96 rounded-xl" />
            </div>
          ) : !comparisonData.hasPrevious ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <GitCompare className="h-12 w-12 text-muted-foreground mb-3" />
                <p className="font-semibold">المقارنة غير متاحة</p>
                <p className="text-sm text-muted-foreground mt-1">
                  حدّد فترة زمنية محددة (من/إلى) لتفعيل المقارنة بالفترة السابقة
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Comparison summary KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <ComparisonStat
                  label="إجمالي الشكاوى"
                  current={v!.total}
                  previous={t!.previousTotal || 0}
                  higherIsBad
                />
                <ComparisonStat
                  label="الشكاوى المغلقة"
                  current={v!.closed}
                  previous={0}
                  hideGrowth
                />
                <ComparisonStat
                  label="معدل الإغلاق"
                  current={p!.closureRate}
                  previous={0}
                  isPercent
                  hideGrowth
                />
                <ComparisonStat
                  label="الشكاوى المتأخرة"
                  current={v!.late}
                  previous={0}
                  higherIsBad
                  hideGrowth
                />
              </div>

              {/* Comparison by Region */}
              <Card className="card-hover">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-emerald-600" /> المقارنة حسب المنطقة
                  </CardTitle>
                  <CardDescription className="text-xs">الشكاوى الحالية مقابل الفترة السابقة لكل منطقة</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={Math.max(280, comparisonData.byRegion.length * 36)}>
                    <BarChart data={comparisonData.byRegion} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={110} />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="current" name="الفترة الحالية" fill="#0d9488" radius={[0, 4, 4, 0]} />
                      <Bar dataKey="previous" name="الفترة السابقة" fill="#cbd5e1" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Comparison by Department */}
                <Card className="card-hover">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-amber-600" /> حسب الإدارة
                    </CardTitle>
                    <CardDescription className="text-xs">مقارنة بسيطة</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={Math.max(240, comparisonData.byDepartment.length * 32)}>
                      <BarChart data={comparisonData.byDepartment} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 11 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={100} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="current" name="الحالية" fill="#f59e0b" radius={[0, 4, 4, 0]} />
                        <Bar dataKey="previous" name="السابقة" fill="#fde68a" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Comparison by Classification */}
                <Card className="card-hover">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Layers className="h-4 w-4 text-purple-600" /> حسب التصنيف
                    </CardTitle>
                    <CardDescription className="text-xs">مقارنة بسيطة</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={Math.max(240, comparisonData.byClassification.length * 32)}>
                      <BarChart data={comparisonData.byClassification} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 11 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={100} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="current" name="الحالية" fill="#a855f7" radius={[0, 4, 4, 0]} />
                        <Bar dataKey="previous" name="السابقة" fill="#e9d5ff" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>

              {/* Growth table */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">جدول معدلات النمو</CardTitle>
                  <CardDescription className="text-xs">تفصيل الفرق بين الفترة الحالية والسابقة</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="text-right py-2 px-3 font-medium">المنطقة</th>
                          <th className="text-center py-2 px-3 font-medium">الفترة السابقة</th>
                          <th className="text-center py-2 px-3 font-medium">الفترة الحالية</th>
                          <th className="text-center py-2 px-3 font-medium">التغيير</th>
                          <th className="text-center py-2 px-3 font-medium">النسبة</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparisonData.byRegion.map((row, i) => {
                          const ev = evaluateComparison(row.current, row.previous, true);
                          const stateClassName = getComparisonStateClassName(ev.state);
                          const differenceLabel = formatComparisonDifference(ev.difference);
                          return (
                            <tr key={i} className="border-b last:border-0 hover:bg-muted/40">
                              <td className="py-2 px-3 font-medium">{row.name}</td>
                              <td className="py-2 px-3 text-center tabular-nums">{formatNumber(row.previous)}</td>
                              <td className="py-2 px-3 text-center tabular-nums font-bold">{formatNumber(row.current)}</td>
                              <td className="py-2 px-3 text-center">
                                <span className={`inline-flex items-center gap-1 ${stateClassName}`}>
                                  <ComparisonDirectionIcon state={ev.state} />
                                  {differenceLabel}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-center">
                                {ev.changeRate !== null ? (
                                  <Badge variant={ev.changeRate > 0 ? "destructive" : "secondary"} className="tabular-nums">
                                    {ev.changeRate > 0 ? "+" : ""}{formatPercent(Math.abs(ev.changeRate))}
                                  </Badge>
                                ) : (
                                  <Badge variant="outline" className="tabular-nums">{ev.label}</Badge>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* ===== Tab 3: Recurring Themes ===== */}
        <TabsContent value="themes" className="mt-4 space-y-4">
          {loading ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Skeleton className="h-96 rounded-xl" />
              <Skeleton className="h-96 rounded-xl" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Top classifications */}
                <Card className="card-hover">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Layers className="h-4 w-4 text-emerald-600" /> التصنيفات الأكثر تكراراً
                    </CardTitle>
                    <CardDescription className="text-xs">أعلى 10 تصنيفات حسب عدد الشكاوى</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={Math.max(280, (analytics?.recurringClassifications.length || 0) * 32)}>
                      <BarChart data={analytics?.recurringClassifications || []} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 11 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
                        <Tooltip content={<ChartTooltip />} />
                        <Bar dataKey="count" name="عدد الشكاوى" radius={[0, 4, 4, 0]}>
                          {(analytics?.recurringClassifications || []).map((_, i) => (
                            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Top subjects list */}
                <Card className="card-hover">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-amber-500" /> الموضوعات المتكررة
                    </CardTitle>
                    <CardDescription className="text-xs">أكثر مواضيع الشكاوى تكراراً</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1 custom-scrollbar">
                      {(analytics?.recurringSubjects || []).map((subject, i) => {
                        const max = analytics?.recurringSubjects[0]?.count || 1;
                        const pct = (subject.count / max) * 100;
                        return (
                          <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors">
                            <div className="flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold shrink-0"
                              style={{ background: `${CHART_COLORS[i % CHART_COLORS.length]}22`, color: CHART_COLORS[i % CHART_COLORS.length] }}>
                              {i + 1}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{subject.name}</p>
                              <div className="h-1.5 bg-muted rounded-full overflow-hidden mt-1">
                                <div className="h-full rounded-full"
                                  style={{ width: `${pct}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} />
                              </div>
                            </div>
                            <Badge variant="outline" className="tabular-nums shrink-0">{formatNumber(subject.count)}</Badge>
                          </div>
                        );
                      })}
                      {(!analytics?.recurringSubjects || analytics.recurringSubjects.length === 0) && (
                        <div className="text-center py-8 text-sm text-muted-foreground">لا توجد بيانات</div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Channel distribution pie + classification pie */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card className="card-hover">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">توزيع قنوات الاستقبال</CardTitle>
                    <CardDescription className="text-xs">نسبة الشكاوى حسب القناة</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie
                          data={dashboard?.distributions.byChannel.map(c => ({ name: c.name, value: c.count })) || []}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={95}
                          label={(entry: any) => `${formatNumber(entry.value)}`}
                          labelLine={false}
                        >
                          {(dashboard?.distributions.byChannel || []).map((_, i) => (
                            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip content={<ChartTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex flex-wrap gap-2 mt-3 justify-center text-xs">
                      {dashboard?.distributions.byChannel.map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                          <span className="text-muted-foreground">{c.name}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Card className="card-hover">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">تصنيفات الأولوية</CardTitle>
                    <CardDescription className="text-xs">توزيع الشكاوى حسب الأولوية</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={dashboard?.distributions.byPriority.map(p => ({ name: PRIORITY_LABELS[p.name] || p.name, count: p.count })) || []}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip content={<ChartTooltip />} />
                        <Bar dataKey="count" name="عدد الشكاوى" radius={[4, 4, 0, 0]}>
                          {PRIORITY_ORDER.map((prio, i) => {
                            const colors = ["#ef4444", "#f97316", "#3b82f6", "#94a3b8"];
                            return <Cell key={i} fill={colors[i] || CHART_COLORS[i]} />;
                          })}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        {/* ===== Tab 4: Relationships (Cross-tabs) ===== */}
        <TabsContent value="relations" className="mt-4 space-y-4">
          {loading ? (
            <Skeleton className="h-[500px] rounded-xl" />
          ) : (
            <>
              {/* Classification × Region Heatmap */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Layers className="h-4 w-4 text-emerald-600" /> التصنيف × المنطقة
                  </CardTitle>
                  <CardDescription className="text-xs">جدول تقاطعي يوضح توزيع الشكاوى حسب التصنيف والمنطقة</CardDescription>
                </CardHeader>
                <CardContent>
                  <Heatmap
                    rows={analytics?.crossTabs.classifications || []}
                    cols={analytics?.crossTabs.regions || []}
                    data={analytics?.crossTabs.classificationByRegion || []}
                    rowKey="classification"
                  />
                </CardContent>
              </Card>

              {/* Classification × Department Heatmap */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-amber-600" /> التصنيف × الإدارة
                  </CardTitle>
                  <CardDescription className="text-xs">جدول تقاطعي يوضح توزيع الشكاوى حسب التصنيف والإدارة</CardDescription>
                </CardHeader>
                <CardContent>
                  <Heatmap
                    rows={analytics?.crossTabs.classifications || []}
                    cols={analytics?.crossTabs.departments || []}
                    data={analytics?.crossTabs.classificationByDepartment || []}
                    rowKey="classification"
                  />
                </CardContent>
              </Card>

              {/* Region × Priority grouped bars */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">أولوية الشكاوى حسب المنطقة</CardTitle>
                  <CardDescription className="text-xs">توزيع مستويات الأولوية لكل منطقة</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={Math.max(300, (analytics?.regionPriorityBreakdown.length || 0) * 50)}>
                    <ComposedChart data={analytics?.regionPriorityBreakdown || []} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="region" tick={{ fontSize: 11 }} width={110} />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="حرجة" stackId="a" fill="#ef4444" />
                      <Bar dataKey="عالية" stackId="a" fill="#f97316" />
                      <Bar dataKey="متوسطة" stackId="a" fill="#3b82f6" />
                      <Bar dataKey="منخفضة" stackId="a" fill="#94a3b8" radius={[0, 4, 4, 0]} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* ===== Tab 5: Pattern Detection ===== */}
        <TabsContent value="patterns" className="mt-4 space-y-4">
          {loading ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Skeleton className="h-96 rounded-xl" />
              <Skeleton className="h-96 rounded-xl" />
            </div>
          ) : (
            <>
              {/* Anomaly highlights */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card className={`border-l-4 ${analytics?.anomalies.regions.some(r => r.isAnomaly) ? "border-l-amber-500" : "border-l-emerald-500"}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertTriangle className={`h-4 w-4 ${analytics?.anomalies.regions.some(r => r.isAnomaly) ? "text-amber-500" : "text-emerald-500"}`} />
                      كشف الأنماط غير الاعتيادية - المناطق
                    </CardTitle>
                    <CardDescription className="text-xs">مناطق يزيد فيها عدد الشكاوى عن 1.5× المتوسط</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1 custom-scrollbar">
                      {(analytics?.anomalies.regions || []).map((r, i) => (
                        <div
                          key={i}
                          className={`flex items-center gap-3 p-3 rounded-lg border ${r.isAnomaly ? "border-amber-300 bg-amber-50/60 dark:bg-amber-950/20" : "border-border bg-muted/30"}`}
                        >
                          {r.isAnomaly ? (
                            <Zap className="h-4 w-4 text-amber-500 shrink-0" />
                          ) : (
                            <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{r.name}</p>
                            <p className="text-xs text-muted-foreground">
                              المتوسط: {formatNumber(r.average)} شكوى
                            </p>
                          </div>
                          <div className="text-left shrink-0">
                            <p className="text-sm font-bold tabular-nums">{formatNumber(r.count)}</p>
                            <p className={`text-xs tabular-nums ${r.deviation > 0 ? "text-red-600" : "text-emerald-600"}`}>
                              {r.deviation > 0 ? "+" : ""}{formatPercent(Math.abs(r.deviation))}
                            </p>
                          </div>
                          {r.isAnomaly && (
                            <Badge variant="destructive" className="shrink-0">شذوذ</Badge>
                          )}
                        </div>
                      ))}
                      {(analytics?.anomalies.regions || []).length === 0 && (
                        <div className="text-center py-8 text-sm text-muted-foreground">لا توجد بيانات</div>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card className={`border-l-4 ${analytics?.anomalies.departments.some(d => d.isAnomaly) ? "border-l-amber-500" : "border-l-emerald-500"}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertTriangle className={`h-4 w-4 ${analytics?.anomalies.departments.some(d => d.isAnomaly) ? "text-amber-500" : "text-emerald-500"}`} />
                      كشف الأنماط غير الاعتيادية - الإدارات
                    </CardTitle>
                    <CardDescription className="text-xs">إدارات يزيد فيها عدد الشكاوى عن 1.5× المتوسط</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1 custom-scrollbar">
                      {(analytics?.anomalies.departments || []).map((d, i) => (
                        <div
                          key={i}
                          className={`flex items-center gap-3 p-3 rounded-lg border ${d.isAnomaly ? "border-amber-300 bg-amber-50/60 dark:bg-amber-950/20" : "border-border bg-muted/30"}`}
                        >
                          {d.isAnomaly ? (
                            <Zap className="h-4 w-4 text-amber-500 shrink-0" />
                          ) : (
                            <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{d.name}</p>
                            <p className="text-xs text-muted-foreground">
                              المتوسط: {formatNumber(d.average)} شكوى
                            </p>
                          </div>
                          <div className="text-left shrink-0">
                            <p className="text-sm font-bold tabular-nums">{formatNumber(d.count)}</p>
                            <p className={`text-xs tabular-nums ${d.deviation > 0 ? "text-red-600" : "text-emerald-600"}`}>
                              {d.deviation > 0 ? "+" : ""}{formatPercent(Math.abs(d.deviation))}
                            </p>
                          </div>
                          {d.isAnomaly && (
                            <Badge variant="destructive" className="shrink-0">شذوذ</Badge>
                          )}
                        </div>
                      ))}
                      {(analytics?.anomalies.departments || []).length === 0 && (
                        <div className="text-center py-8 text-sm text-muted-foreground">لا توجد بيانات</div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Channel effectiveness */}
              <Card className="card-hover">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" /> فعالية قنوات الاستقبال
                  </CardTitle>
                  <CardDescription className="text-xs">معدلات الإغلاق والتأخير ومتوسط زمن المعالجة لكل قناة</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {(analytics?.channelEffectiveness || []).map((ch, i) => (
                      <div key={i} className="border border-border rounded-xl p-4 space-y-3 hover:shadow-sm transition-shadow bg-card">
                        <div className="flex items-center justify-between">
                          <h4 className="font-semibold text-sm">{ch.channel}</h4>
                          <Badge variant="outline" className="tabular-nums">{formatNumber(ch.total)}</Badge>
                        </div>
                        <div className="space-y-2">
                          <div>
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="text-muted-foreground">معدل الإغلاق</span>
                              <span className="font-bold tabular-nums">{formatPercent(ch.closureRate)}</span>
                            </div>
                            <Progress value={ch.closureRate} className="h-2" />
                          </div>
                          <div>
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="text-muted-foreground">معدل التأخير</span>
                              <span className={`font-bold tabular-nums ${ch.lateRate > 30 ? "text-red-600" : ch.lateRate > 15 ? "text-amber-600" : "text-emerald-600"}`}>
                                {formatPercent(ch.lateRate)}
                              </span>
                            </div>
                            <Progress value={ch.lateRate} className="h-2" />
                          </div>
                        </div>
                        <div className="flex items-center justify-between pt-2 border-t text-xs">
                          <span className="text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" /> متوسط المعالجة
                          </span>
                          <span className="font-medium tabular-nums">{formatDuration(ch.avgProcessingHours)}</span>
                        </div>
                      </div>
                    ))}
                    {(analytics?.channelEffectiveness || []).length === 0 && (
                      <div className="col-span-full text-center py-8 text-sm text-muted-foreground">لا توجد بيانات</div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Channel effectiveness bar chart */}
              <Card className="card-hover">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">مقارنة معدلات الإغلاق والتأخير حسب القناة</CardTitle>
                  <CardDescription className="text-xs">نسبة مئوية لكل قناة</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={analytics?.channelEffectiveness.map(c => ({
                      name: c.channel, "معدل الإغلاق": c.closureRate, "معدل التأخير": c.lateRate,
                    })) || []}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${v}%`} />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="معدل الإغلاق" fill="#0d9488" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="معدل التأخير" fill="#ef4444" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Delay reasons */}
              <Card className="card-hover">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Clock className="h-4 w-4 text-red-500" /> أسباب التأخير
                  </CardTitle>
                  <CardDescription className="text-xs">أكثر أسباب تأخير معالجة الشكاوى تكراراً</CardDescription>
                </CardHeader>
                <CardContent>
                  {(analytics?.delayReasons && analytics.delayReasons.length > 0) ? (
                    <ResponsiveContainer width="100%" height={Math.max(260, analytics.delayReasons.length * 36)}>
                      <BarChart data={analytics.delayReasons} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 11 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={160} />
                        <Tooltip content={<ChartTooltip />} />
                        <Bar dataKey="count" name="عدد الحالات" radius={[0, 4, 4, 0]}>
                          {analytics.delayReasons.map((_, i) => (
                            <Cell key={i} fill={i === 0 ? "#ef4444" : i === 1 ? "#f97316" : "#f59e0b"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="text-center py-12 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-2" />
                      لا توجد أسباب تأخير مسجلة في هذه الفترة
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Region scatter: total vs critical */}
              <Card className="card-hover">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Activity className="h-4 w-4 text-purple-600" /> مصفوفة الحجم مقابل الأولوية الحرجة
                  </CardTitle>
                  <CardDescription className="text-xs">العلاقة بين إجمالي الشكاوى وعدد الشكاوى الحرجة لكل منطقة</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={320}>
                    <ScatterChart>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis
                        type="number"
                        dataKey="total"
                        name="إجمالي الشكاوى"
                        tick={{ fontSize: 11 }}
                        label={{ value: "إجمالي الشكاوى", position: "insideBottom", offset: -5, fontSize: 11 }}
                      />
                      <YAxis
                        type="number"
                        dataKey="critical"
                        name="الشكاوى الحرجة"
                        tick={{ fontSize: 11 }}
                        label={{ value: "الشكاوى الحرجة", angle: -90, position: "insideLeft", fontSize: 11 }}
                      />
                      <ZAxis type="number" dataKey="total" range={[60, 400]} />
                      <Tooltip
                        cursor={{ strokeDasharray: "3 3" }}
                        content={({ active, payload }: any) => {
                          if (!active || !payload || payload.length === 0) return null;
                          const d = payload[0].payload;
                          return (
                            <div className="rounded-xl border border-border bg-popover/95 backdrop-blur p-3 shadow-lg text-xs space-y-1">
                              <p className="font-semibold">{d.name}</p>
                              <p className="text-muted-foreground">الإجمالي: <span className="font-bold text-foreground">{formatNumber(d.total)}</span></p>
                              <p className="text-muted-foreground">الحرجة: <span className="font-bold text-red-600">{formatNumber(d.critical)}</span></p>
                            </div>
                          );
                        }}
                      />
                      <Scatter
                        data={(analytics?.regionPriorityBreakdown || []).map(r => ({
                          name: r.region,
                          total: r.total as number,
                          critical: r["حرجة"] as number,
                        }))}
                        fill="#a855f7"
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="operational" className="mt-4 space-y-4">
          <OperationalAnalyticsPanel
            from={from}
            to={to}
            regionId={regionId}
            departmentId={departmentId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- Heatmap Component ----------
function Heatmap({
  rows, cols, data, rowKey,
}: {
  rows: string[];
  cols: string[];
  data: Record<string, number | string>[];
  rowKey: string;
}) {
  // Find max value for color scaling
  let max = 0;
  for (const row of data) {
    for (const col of cols) {
      const v = Number(row[col] || 0);
      if (v > max) max = v;
    }
  }

  function cellColor(value: number): { background: string; color: string } {
    if (value === 0 || max === 0) return { background: "transparent", color: "var(--muted-foreground)" };
    const intensity = value / max;
    // Teal gradient: from light to dark
    const alpha = 0.15 + intensity * 0.85;
    return {
      background: `rgba(13, 148, 136, ${alpha})`,
      color: intensity > 0.55 ? "#ffffff" : "var(--foreground)",
    };
  }

  if (rows.length === 0 || cols.length === 0) {
    return <div className="text-center py-8 text-sm text-muted-foreground">لا توجد بيانات للعرض</div>;
  }

  return (
    <div className="overflow-x-auto custom-scrollbar">
      <table className="w-full text-xs border-separate border-spacing-1">
        <thead>
          <tr>
            <th className="sticky right-0 bg-card p-2 text-right font-medium text-muted-foreground min-w-[140px]">
              التصنيف \ المنطقة
            </th>
            {cols.map((col, i) => (
              <th key={i} className="p-2 font-medium text-muted-foreground text-center min-w-[80px] whitespace-nowrap">
                {col}
              </th>
            ))}
            <th className="p-2 font-bold text-foreground text-center bg-muted/40 rounded min-w-[60px]">الإجمالي</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => {
            let rowTotal = 0;
            for (const col of cols) rowTotal += Number(row[col] || 0);
            return (
              <tr key={i} className="hover:bg-muted/30">
                <td className="sticky right-0 bg-card p-2 text-right font-medium whitespace-nowrap border-r-2 border-border">
                  {String(row[rowKey])}
                </td>
                {cols.map((col, j) => {
                  const value = Number(row[col] || 0);
                  const { background, color } = cellColor(value);
                  return (
                    <td
                      key={j}
                      className="p-2 text-center tabular-nums rounded transition-all hover:scale-105 hover:ring-2 hover:ring-emerald-400 cursor-default"
                      style={{ background, color }}
                      title={`${String(row[rowKey])} × ${col}: ${formatNumber(value)}`}
                    >
                      {value > 0 ? formatNumber(value) : <span className="text-muted-foreground/30">—</span>}
                    </td>
                  );
                })}
                <td className="p-2 text-center tabular-nums font-bold bg-muted/40 rounded">
                  {formatNumber(rowTotal)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Insight Card ----------
type InsightType = "positive" | "negative" | "warning" | "neutral";

interface Insight {
  type: InsightType;
  icon: "trending-up" | "trending-down" | "alert" | "sparkles";
  title: string;
  text: string;
}

function InsightCard({ insight }: { insight: Insight }) {
  const typeStyles: Record<InsightType, string> = {
    positive: "border-l-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/10",
    negative: "border-l-red-500 bg-red-50/40 dark:bg-red-950/10",
    warning: "border-l-amber-500 bg-amber-50/40 dark:bg-amber-950/10",
    neutral: "border-l-slate-400 bg-muted/30",
  };
  const iconStyles: Record<InsightType, string> = {
    positive: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600",
    negative: "bg-red-100 dark:bg-red-900/40 text-red-600",
    warning: "bg-amber-100 dark:bg-amber-900/40 text-amber-600",
    neutral: "bg-slate-100 dark:bg-slate-800 text-slate-600",
  };
  const icons = {
    "trending-up": TrendingUp,
    "trending-down": TrendingDown,
    "alert": AlertTriangle,
    "sparkles": Sparkles,
  };
  const Icon = icons[insight.icon];

  return (
    <Card className={`border-l-4 ${typeStyles[insight.type]}`}>
      <CardContent className="flex items-start gap-3 p-4">
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${iconStyles[insight.type]}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">{insight.title}</p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{insight.text}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Comparison Stat ----------
function ComparisonStat({
  label, current, previous, isPercent, higherIsBad, hideGrowth,
}: {
  label: string;
  current: number;
  previous: number;
  isPercent?: boolean;
  higherIsBad?: boolean;
  hideGrowth?: boolean;
}) {
  const ev = evaluateComparison(current, previous, true);
  const isUp = ev.state === "INCREASE";
  const isPositiveTrend = higherIsBad ? !isUp : isUp;
  const fmt = (n: number) => isPercent ? formatPercent(n) : formatNumber(n);

  return (
    <Card>
      <CardContent className="p-4 space-y-1.5">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="flex items-baseline gap-2">
          <p className="text-2xl font-bold tabular-nums">{fmt(current)}</p>
          {!hideGrowth && ev.changeRate !== null && (
            <span className={`text-xs font-medium tabular-nums flex items-center gap-0.5 ${isPositiveTrend ? "text-emerald-600" : "text-red-600"}`}>
              {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {ev.changeRate > 0 ? "+" : ""}{formatPercent(Math.abs(ev.changeRate))}
            </span>
          )}
        </div>
        {!hideGrowth && ev.previous !== null && (
          <p className="text-xs text-muted-foreground">السابقة: {fmt(ev.previous)}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Derived data builders ----------
function buildInsights(dash: DashboardData | null, ana: AnalyticsData | null): Insight[] {
  if (!dash) return [];

  const insights: Insight[] = [];

  // Growth rate insight. Secondary defense only — `dash` is already validated
  // by isDashboardData before it ever reaches state, so `trend` is always an
  // object here; the optional chain guards against this function someday
  // being called with unvalidated data, it does not replace that validation.
  // A missing/undefined growthRate is treated the same as an absent value
  // (no insight pushed) — never coerced to a number (no growth is not the
  // same claim as zero growth).
  const growthRate = dash.trend?.growthRate;
  if (growthRate !== null && growthRate !== undefined) {
    if (growthRate > 10) {
      insights.push({
        type: "negative",
        icon: "trending-up",
        title: "ارتفاع ملحوظ في الشكاوى",
        text: `ارتفع إجمالي الشكاوى بنسبة ${formatPercent(growthRate)} مقارنة بالفترة السابقة، مما يستدعي مراجعة الأسباب المحتملة.`,
      });
    } else if (growthRate < -10) {
      insights.push({
        type: "positive",
        icon: "trending-down",
        title: "انخفاض إيجابي في الشكاوى",
        text: `انخفض إجمالي الشكاوى بنسبة ${formatPercent(Math.abs(growthRate))} مقارنة بالفترة السابقة، وهو مؤشر إيجابي على تحسن الخدمات.`,
      });
    } else {
      insights.push({
        type: "neutral",
        icon: "sparkles",
        title: "استقرار في حجم الشكاوى",
        text: `بلغ التغير في حجم الشكاوى ${formatPercent(Math.abs(growthRate))} مقارنة بالفترة السابقة، مما يدل على استقرار نسبي.`,
      });
    }
  }

  // Region spike insight
  if (ana?.anomalies.regions) {
    const anomaly = ana.anomalies.regions.find(r => r.isAnomaly);
    if (anomaly) {
      insights.push({
        type: "warning",
        icon: "alert",
        title: `ارتفاع غير اعتيادي في ${anomaly.name}`,
        text: `سجلت منطقة ${anomaly.name} ${formatNumber(anomaly.count)} شكوى، وهو ما يزيد عن ${formatPercent(anomaly.deviation)} من المتوسط، مما يتطلب تحقيقاً معمقاً.`,
      });
    }
  }

  // Closure rate insight
  if (dash.performance.closureRate >= 80) {
    insights.push({
      type: "positive",
      icon: "trending-up",
      title: "أداء إغلاق ممتاز",
      text: `بلغ معدل الإغلاق ${formatPercent(dash.performance.closureRate)}، وهو ضمن النطاق الممتاز (80% فأكثر).`,
    });
  } else if (dash.performance.closureRate < 50) {
    insights.push({
      type: "negative",
      icon: "alert",
      title: "معدل إغلاق منخفض",
      text: `بلغ معدل الإغلاق ${formatPercent(dash.performance.closureRate)} فقط، وهو أقل من المعدل المقبول. يُنصح بمراجعة العمليات.`,
    });
  } else {
    insights.push({
      type: "neutral",
      icon: "sparkles",
      title: "معدل إغلاق معتدل",
      text: `بلغ معدل الإغلاق ${formatPercent(dash.performance.closureRate)}، وهناك مجال للتحسن للوصول إلى 80%.`,
    });
  }

  // Late rate insight
  if (dash.volume.late > 0 && dash.volume.total > 0) {
    const latePct = (dash.volume.late / dash.volume.total) * 100;
    if (latePct > 25) {
      insights.push({
        type: "negative",
        icon: "alert",
        title: "نسبة تأخير مرتفعة",
        text: `${formatNumber(dash.volume.late)} شكوى متأخرة (${formatPercent(latePct)} من الإجمالي). يجب اتخاذ إجراءات عاجلة لتسريع المعالجة.`,
      });
    }
  }

  // Channel insight
  if (ana?.channelEffectiveness && ana.channelEffectiveness.length > 0) {
    const best = [...ana.channelEffectiveness].sort((a, b) => b.closureRate - a.closureRate)[0];
    insights.push({
      type: "positive",
      icon: "sparkles",
      title: `أفضل قناة أداءً: ${best.channel}`,
      text: `تتميز قناة "${best.channel}" بأعلى معدل إغلاق (${formatPercent(best.closureRate)}) من بين قنوات الاستقبال، بمتوسط معالجة ${formatDuration(best.avgProcessingHours)}.`,
    });
  }

  // Top classification insight
  if (ana?.recurringClassifications && ana.recurringClassifications.length > 0) {
    const top = ana.recurringClassifications[0];
    const pctOfTotal = ana.totalCount > 0 ? (top.count / ana.totalCount) * 100 : 0;
    insights.push({
      type: "neutral",
      icon: "sparkles",
      title: `التصنيف الأكثر تكراراً: ${top.name}`,
      text: `يستحوذ تصنيف "${top.name}" على ${formatNumber(top.count)} شكوى (${formatPercent(pctOfTotal)} من الإجمالي)، مما يشير إلى مشكلة متكررة تستحق المعالجة الجذرية.`,
    });
  }

  return insights.slice(0, 3);
}

/** Secondary defense: coerces anything that isn't an array to empty, rather than letting `.map`/`.find` throw. */
function toNameCountArray(value: unknown): { name: string; count: number }[] {
  return Array.isArray(value) ? value : [];
}

function buildComparisonData(dash: DashboardData | null, ana: AnalyticsData | null) {
  const empty = { hasPrevious: false, byRegion: [], byDepartment: [], byClassification: [] };
  if (!dash || !ana || !ana.previousDistributions) return empty;

  const merge = (
    current: { name: string; count: number }[],
    previous: { name: string; count: number }[],
  ) => {
    const safeCurrent = toNameCountArray(current);
    const safePrevious = toNameCountArray(previous);
    const allNames = new Set<string>([...safeCurrent.map(c => c.name), ...safePrevious.map(p => p.name)]);
    return Array.from(allNames).map(name => {
      const c = safeCurrent.find(x => x.name === name);
      const p = safePrevious.find(x => x.name === name);
      return {
        name,
        current: c?.count || 0,
        previous: p?.count || 0,
      };
    }).sort((a, b) => b.current - a.current);
  };

  return {
    hasPrevious: true,
    byRegion: merge(dash.distributions?.byRegion, ana.previousDistributions.byRegion),
    byDepartment: merge(dash.distributions?.byDepartment, ana.previousDistributions.byDepartment),
    byClassification: merge(dash.distributions?.byClassification, ana.previousDistributions.byClassification),
  };
}

function buildCumulative(trendData: { date: string; total: number; closed: number }[]) {
  let cumulativeTotal = 0;
  let cumulativeClosed = 0;
  return trendData.map(d => {
    cumulativeTotal += d.total;
    cumulativeClosed += d.closed;
    return {
      date: d.date,
      cumulativeTotal,
      cumulativeClosed,
    };
  });
}
