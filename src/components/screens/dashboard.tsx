"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LayoutDashboard, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2,
  Clock, FileWarning, Activity, Users, MapPin, Building2, RefreshCw,
  ArrowLeft, Bell, Database, Sparkles, Calendar,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line, RadialBarChart, RadialBar, Legend,
} from "recharts";
import {
  formatNumber, formatPercent, formatDate, formatDuration,
  STATUS_LABELS, STATUS_COLORS, PRIORITY_LABELS,
} from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";
import type { ScreenId } from "@/app/page";

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

const CHART_COLORS = ["#0d9488", "#f59e0b", "#3b82f6", "#ef4444", "#a855f7", "#14b8a6", "#f97316", "#ec4899"];

export function Dashboard({ onNavigate }: { onNavigate: (s: ScreenId) => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRequestRef = useRef(0);

  const loadData = useCallback(async (signal?: AbortSignal) => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    const canUpdate = () => !signal?.aborted && loadRequestRef.current === requestId;
    setLoading(true);
    let aborted = false;
    try {
      const res = await fetch("/api/dashboard", { signal });
      const json = await res.json();
      if (canUpdate()) {
        setData(json);
      }
    } catch (e) {
      aborted = isAbortError(e);
      if (!aborted) {
        console.error(e);
      }
    } finally {
      if (!aborted && canUpdate()) {
        setLoading(false);
      }
    }
  }, []);

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

  const v = data?.volume;
  const p = data?.performance;
  const t = data?.trend;
  const a = data?.alerts;

  return (
    <div className="space-y-6">
      <PageHeader
        title="الشاشة الرئيسية"
        description="نظرة شاملة على مؤشرات الشكاوى والأداء"
        icon={<LayoutDashboard className="h-6 w-6" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void loadData()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              تحديث
            </Button>
            <Button size="sm" onClick={() => onNavigate("import")}>
              <Sparkles className="h-4 w-4" />
              رفع ملف جديد
            </Button>
          </>
        }
      />

      {/* Critical Alerts Banner */}
      {data && (a!.criticalComplaints > 0 || a!.lateCritical > 0) && (
        <Card className="border-red-200 bg-red-50/50 dark:bg-red-950/20">
          <CardContent className="flex items-center gap-4 py-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/40">
              <AlertTriangle className="h-6 w-6 text-red-600" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-red-900 dark:text-red-200">تنبيهات حرجة تتطلب attention فوري</p>
              <p className="text-sm text-red-700 dark:text-red-300">
                {a!.criticalComplaints > 0 && `${formatNumber(a!.criticalComplaints)} شكوى حرجة`}
                {a!.criticalComplaints > 0 && a!.lateCritical > 0 && " • "}
                {a!.lateCritical > 0 && `${formatNumber(a!.lateCritical)} شكوى حرجة متأخرة`}
              </p>
            </div>
            <Button variant="destructive" size="sm" onClick={() => onNavigate("explorer")}>
              عرض التفاصيل
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Volume KPIs */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4" />
          مؤشرات الحجم
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))
          ) : (
            <>
              <KpiCard label="إجمالي الشكاوى" value={v!.total} icon={<Database className="h-5 w-5" />} color="primary" />
              <KpiCard label="المفتوحة" value={v!.open} icon={<Clock className="h-5 w-5" />} color="blue" />
              <KpiCard label="قيد المعالجة" value={v!.inProgress} icon={<Activity className="h-5 w-5" />} color="amber" />
              <KpiCard label="المغلقة" value={v!.closed} icon={<CheckCircle2 className="h-5 w-5" />} color="emerald" />
              <KpiCard label="المتأخرة" value={v!.late} icon={<FileWarning className="h-5 w-5" />} color="red" highlight={v!.late > 0} />
              <KpiCard label="معاد فتحها" value={v!.reopened} icon={<RefreshCw className="h-5 w-5" />} color="purple" />
            </>
          )}
        </div>
      </div>

      {/* Secondary volume indicators */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)
        ) : (
          <>
            <MiniStat label="الشكاوى المكررة" value={v!.repeated} icon={<RefreshCw className="h-4 w-4" />} />
            <MiniStat label="ثبتت صحتها" value={v!.validated} icon={<CheckCircle2 className="h-4 w-4" />} />
            <MiniStat label="لم تثبت صحتها" value={v!.notValidated} icon={<FileWarning className="h-4 w-4" />} />
            <MiniStat label="تشابه محتمل" value={v!.potentialDuplicates} icon={<AlertTriangle className="h-4 w-4" />} />
          </>
        )}
      </div>

      {/* Charts row 1: Trend + Status distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 card-hover">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">اتجاه الشكاوى (آخر 30 يوم)</CardTitle>
                <CardDescription className="text-xs">عدد الشكاوى الواردة والمغلقة يومياً</CardDescription>
              </div>
              {t?.growthRate !== null && t?.growthRate !== undefined && (
                <Badge variant={t.growthRate > 0 ? "destructive" : "default"} className="gap-1">
                  {t.growthRate > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {t.growthRate > 0 ? "ارتفاع" : "انخفاض"} {Math.abs(t.growthRate)}%
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={t!.trendData}>
                  <defs>
                    <linearGradient id="totalGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0d9488" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="closedGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => formatDate(d).split(" ").slice(0, 2).join(" ")} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
                    labelFormatter={(d) => formatDate(d as string)}
                  />
                  <Area type="monotone" dataKey="total" name="الواردة" stroke="#0d9488" strokeWidth={2} fill="url(#totalGrad)" />
                  <Area type="monotone" dataKey="closed" name="المغلقة" stroke="#22c55e" strokeWidth={2} fill="url(#closedGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="card-hover">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">توزيع الحالات</CardTitle>
            <CardDescription className="text-xs">حالات الشكاوى الحالية</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={data!.distributions.byStatus.map(s => ({ name: STATUS_LABELS[s.name] || s.name, value: s.count }))}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    innerRadius={40}
                    paddingAngle={2}
                  >
                    {data!.distributions.byStatus.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Performance Indicators */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          مؤشرات الأداء
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)
          ) : (
            <>
              <PerfCard
                title="نسبة الإغلاق"
                value={p!.closureRate}
                suffix="%"
                icon={<CheckCircle2 className="h-5 w-5" />}
                color="emerald"
                target={80}
              />
              <PerfCard
                title="الإغلاق ضمن المهلة"
                value={p!.onTimeRate}
                suffix="%"
                icon={<Clock className="h-5 w-5" />}
                color="blue"
                target={90}
              />
              <PerfCard
                title="نسبة التأخر"
                value={p!.lateRate}
                suffix="%"
                icon={<FileWarning className="h-5 w-5" />}
                color="red"
                target={10}
                inverse
              />
              <PerfCard
                title="رضا المستفيدين"
                value={p!.satisfactionRate}
                suffix="%"
                icon={<Users className="h-5 w-5" />}
                color="purple"
                target={85}
              />
            </>
          )}
        </div>
      </div>

      {/* Time metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
        ) : (
          <>
            <Card className="card-hover">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">متوسط زمن أول استجابة</p>
                  <p className="text-2xl font-bold mt-1">{formatDuration(p!.avgFirstResponseHours)}</p>
                </div>
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-100 dark:bg-blue-900/30">
                  <Clock className="h-6 w-6 text-blue-600" />
                </div>
              </CardContent>
            </Card>
            <Card className="card-hover">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">متوسط زمن المعالجة</p>
                  <p className="text-2xl font-bold mt-1">{formatDuration(p!.avgProcessingHours)}</p>
                </div>
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100 dark:bg-emerald-900/30">
                  <Activity className="h-6 w-6 text-emerald-600" />
                </div>
              </CardContent>
            </Card>
            <Card className="card-hover">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">متوسط عمر الشكاوى المفتوحة</p>
                  <p className="text-2xl font-bold mt-1">{formatDuration(p!.avgOpenAgeHours)}</p>
                </div>
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-900/30">
                  <Calendar className="h-6 w-6 text-amber-600" />
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Charts row 2: Region + Classification */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="card-hover">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              التوزيع حسب المنطقة
            </CardTitle>
            <CardDescription className="text-xs">عدد الشكاوى في كل منطقة</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data!.distributions.byRegion.slice(0, 8)} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={100} />
                  <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="count" name="الشكاوى" fill="#0d9488" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="card-hover">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              التوزيع حسب التصنيف
            </CardTitle>
            <CardDescription className="text-xs">أكثر التصنيفات تكراراً</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data!.distributions.byClassification.slice(0, 8)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="count" name="الشكاوى" radius={[6, 6, 0, 0]}>
                    {data!.distributions.byClassification.slice(0, 8).map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Departments ranking + Data quality */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 card-hover">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              أداء الإدارات
            </CardTitle>
            <CardDescription className="text-xs">عدد الشكاوى المحالة لكل إدارة</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {data!.distributions.byDepartment.slice(0, 10).map((dept, i) => {
                  const max = data!.distributions.byDepartment[0]?.count || 1;
                  const pct = (dept.count / max) * 100;
                  return (
                    <div key={dept.name} className="flex items-center gap-3">
                      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-xs font-bold shrink-0">
                        {i + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="truncate font-medium">{dept.name}</span>
                          <span className="text-muted-foreground tabular-nums">{formatNumber(dept.count)}</span>
                        </div>
                        <Progress value={pct} className="h-2" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="card-hover">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              جودة البيانات
            </CardTitle>
            <CardDescription className="text-xs">نسبة اكتمال البيانات</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <div className="flex flex-col items-center justify-center py-4">
                <ResponsiveContainer width="100%" height={160}>
                  <RadialBarChart
                    innerRadius="70%"
                    outerRadius="100%"
                    data={[{ name: "الجودة", value: a!.dataQualityRate, fill: a!.dataQualityRate >= 90 ? "#22c55e" : "#f59e0b" }]}
                    startAngle={90}
                    endAngle={-270}
                  >
                    <RadialBar background dataKey="value" cornerRadius={10} />
                  </RadialBarChart>
                </ResponsiveContainer>
                <div className="text-center -mt-24">
                  <p className="text-3xl font-bold">{a!.dataQualityRate}%</p>
                  <p className="text-xs text-muted-foreground">جودة البيانات</p>
                </div>
                <div className="mt-20 w-full space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">سجلات ناقصة</span>
                    <span className="font-medium text-amber-600">{formatNumber(a!.missingFields)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">شكاوى حرجة</span>
                    <span className="font-medium text-red-600">{formatNumber(a!.criticalComplaints)}</span>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Latest import + Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="card-hover">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              آخر ملف تم اعتماده
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100 dark:bg-emerald-900/30">
                <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              </div>
              <div className="flex-1">
                <p className="font-medium">شكاوى_أكتوبر_2024.xlsx</p>
                <p className="text-xs text-muted-foreground">
                  248 سجل • اعتمد في {formatDate("2024-11-02")}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => onNavigate("import-log")}>
                السجل
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="card-hover">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">إجراءات سريعة</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => onNavigate("import")}>
              <Sparkles className="h-4 w-4" /> رفع ملف
            </Button>
            <Button variant="outline" size="sm" onClick={() => onNavigate("explorer")}>
              <Building2 className="h-4 w-4" /> استكشاف الشكاوى
            </Button>
            <Button variant="outline" size="sm" onClick={() => onNavigate("reports")}>
              <FileWarning className="h-4 w-4" /> إنشاء تقرير
            </Button>
            <Button variant="outline" size="sm" onClick={() => onNavigate("ai-analysis")}>
              <Sparkles className="h-4 w-4" /> تحليل ذكي
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({
  label, value, icon, color, highlight,
}: {
  label: string; value: number; icon: React.ReactNode;
  color: "primary" | "blue" | "amber" | "emerald" | "red" | "purple";
  highlight?: boolean;
}) {
  const colors: Record<string, string> = {
    primary: "bg-primary/10 text-primary",
    blue: "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400",
    amber: "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400",
    emerald: "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400",
    red: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
    purple: "bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400",
  };
  return (
    <Card className={`card-hover ${highlight ? "border-red-200 bg-red-50/30 dark:bg-red-950/10" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${colors[color]}`}>
            {icon}
          </div>
        </div>
        <p className="text-2xl font-bold tabular-nums">{formatNumber(value)}</p>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </div>
      <div>
        <p className="text-lg font-bold tabular-nums">{formatNumber(value)}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function PerfCard({
  title, value, suffix, icon, color, target, inverse,
}: {
  title: string; value: number; suffix: string; icon: React.ReactNode;
  color: "emerald" | "blue" | "red" | "purple";
  target: number; inverse?: boolean;
}) {
  const colors: Record<string, { bg: string; text: string; bar: string }> = {
    emerald: { bg: "bg-emerald-100 dark:bg-emerald-900/30", text: "text-emerald-600", bar: "bg-emerald-500" },
    blue: { bg: "bg-blue-100 dark:bg-blue-900/30", text: "text-blue-600", bar: "bg-blue-500" },
    red: { bg: "bg-red-100 dark:bg-red-900/30", text: "text-red-600", bar: "bg-red-500" },
    purple: { bg: "bg-purple-100 dark:bg-purple-900/30", text: "text-purple-600", bar: "bg-purple-500" },
  };
  const c = colors[color];
  const isGood = inverse ? value <= target : value >= target;
  return (
    <Card className="card-hover">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${c.bg} ${c.text}`}>
            {icon}
          </div>
          <Badge variant={isGood ? "secondary" : "destructive"} className="text-xs">
            {isGood ? "ضمن المستهدف" : "تحت المستهدف"}
          </Badge>
        </div>
        <p className="text-2xl font-bold tabular-nums">{value}{suffix}</p>
        <p className="text-xs text-muted-foreground mt-1">{title}</p>
        <Progress value={value} className="h-1.5 mt-2" />
      </CardContent>
    </Card>
  );
}
