"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber, formatPercent } from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";
import type { OperationalAnalyticsSummary } from "@/server/analytics/operational/operational-analytics-types";
import { OPERATIONAL_UNSPECIFIED } from "@/server/analytics/operational/operational-analytics-types";

type FilterOption = { id: string; name: string };

type Props = Readonly<{
  from: string;
  to: string;
  regionId: string;
  departmentId: string;
}>;

export type ApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
  };
};

export async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const errorPayload = payload as ApiErrorPayload | null;
    throw new Error(
      errorPayload?.error?.message ?? `Request failed with status ${response.status}`
    );
  }

  return payload as T;
}

function drillDownHref(base: URLSearchParams, extra: Record<string, string>): string {
  const params = new URLSearchParams(base);
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  params.set("screen", "explorer");
  return `/?${params.toString()}`;
}

export function OperationalAnalyticsPanel({ from, to, regionId, departmentId }: Props) {
  const [data, setData] = useState<OperationalAnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [filtersError, setFiltersError] = useState<string | null>(null);
  const [sourceOrigin, setSourceOrigin] = useState("all");
  const [sourceStatus, setSourceStatus] = useState("all");
  const [sourceActionStatus, setSourceActionStatus] = useState("all");
  const [wingCode, setWingCode] = useState("all");
  const [channel, setChannel] = useState("all");
  const [freshness, setFreshness] = useState("all");
  const [options, setOptions] = useState<{
    sourceOrigins: FilterOption[];
    sourceStatuses: FilterOption[];
    sourceActionStatuses: FilterOption[];
    wingCodes: FilterOption[];
    channels: string[];
    dataFreshnessBuckets: FilterOption[];
  } | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        setFiltersError(null);
        const res = await fetch("/api/filters", { signal: controller.signal });
        const json = await readJsonResponse<{
          sourceOrigins?: FilterOption[];
          sourceStatuses?: FilterOption[];
          sourceActionStatuses?: FilterOption[];
          wingCodes?: FilterOption[];
          channels?: string[];
          dataFreshnessBuckets?: FilterOption[];
        }>(res);
        if (!controller.signal.aborted) {
          setOptions({
            sourceOrigins: json.sourceOrigins ?? [],
            sourceStatuses: json.sourceStatuses ?? [],
            sourceActionStatuses: json.sourceActionStatuses ?? [],
            wingCodes: (json.wingCodes ?? []).slice(0, 80),
            channels: json.channels ?? [],
            dataFreshnessBuckets: json.dataFreshnessBuckets ?? [],
          });
        }
      } catch (e) {
        if (isAbortError(e) || controller.signal.aborted) return;
        setFiltersError("تعذر تحميل خيارات الفلاتر.");
        console.error("Failed to load filter options");
      }
    })();
    return () => controller.abort();
  }, []);

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (regionId && regionId !== "all") params.set("regionId", regionId);
    if (departmentId && departmentId !== "all") params.set("departmentId", departmentId);
    if (sourceOrigin !== "all") params.set("sourceOrigin", sourceOrigin);
    if (sourceStatus !== "all") params.set("sourceStatus", sourceStatus);
    if (sourceActionStatus !== "all") params.set("sourceActionStatus", sourceActionStatus);
    if (wingCode !== "all") params.set("wingCode", wingCode);
    if (channel !== "all") params.set("channel", channel);
    if (freshness !== "all") params.set("dataFreshnessBucket", freshness);
    return params;
  }, [
    from,
    to,
    regionId,
    departmentId,
    sourceOrigin,
    sourceStatus,
    sourceActionStatus,
    wingCode,
    channel,
    freshness,
  ]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      setLoading(true);
      setAnalyticsError(null);
      try {
        const res = await fetch(`/api/analytics/operational?${buildParams()}`, { signal });
        const json = await readJsonResponse<OperationalAnalyticsSummary>(res);
        if (!signal?.aborted && requestRef.current === requestId) {
          setData(json);
          setAnalyticsError(null);
        }
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) return;
        if (requestRef.current === requestId) {
          setData(null);
          setAnalyticsError(
            e instanceof Error ? e.message : "تعذر تحميل التحليلات التشغيلية."
          );
        }
      } finally {
        if (!signal?.aborted && requestRef.current === requestId) setLoading(false);
      }
    },
    [buildParams]
  );

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        void load(controller.signal);
      }
    });
    return () => controller.abort();
  }, [load]);

  if (loading && !data && !analyticsError) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (analyticsError && !data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-8">
          <p className="text-sm text-muted-foreground">{analyticsError}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void load();
            }}
          >
            إعادة المحاولة
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          تعذر تحميل التحليلات التشغيلية.
        </CardContent>
      </Card>
    );
  }

  const base = buildParams();

  return (
    <div className="space-y-4">
      {filtersError ? (
        <p className="text-sm text-destructive" role="alert">
          {filtersError}
        </p>
      ) : null}
      {analyticsError ? (
        <div className="flex items-center gap-3 text-sm text-destructive" role="alert">
          <span>{analyticsError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            إعادة المحاولة
          </Button>
        </div>
      ) : null}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">فلاتر تشغيلية</CardTitle>
          <CardDescription>
            مصدر الورود مستقل عن القناة. الحالة المصدرية مستقلة عن الحالة الداخلية.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <FilterSelect
            label="مصدر الورود"
            value={sourceOrigin}
            onChange={setSourceOrigin}
            options={options?.sourceOrigins ?? []}
          />
          <FilterSelect
            label="القناة"
            value={channel}
            onChange={setChannel}
            options={(options?.channels ?? []).map((c) => ({ id: c, name: c }))}
          />
          <FilterSelect
            label="الحالة المصدرية"
            value={sourceStatus}
            onChange={setSourceStatus}
            options={options?.sourceStatuses ?? []}
          />
          <FilterSelect
            label="حالة الإجراء المصدرية"
            value={sourceActionStatus}
            onChange={setSourceActionStatus}
            options={options?.sourceActionStatuses ?? []}
          />
          <FilterSelect
            label="الجناح"
            value={wingCode}
            onChange={setWingCode}
            options={options?.wingCodes ?? []}
          />
          <FilterSelect
            label="حداثة البيانات"
            value={freshness}
            onChange={setFreshness}
            options={options?.dataFreshnessBuckets ?? []}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard title="نطاق التحليل" value={formatNumber(data.totalInScope)} />
        <MetricCard
          title="نسبة البيانات الحديثة"
          value={formatPercent(data.freshness.freshShare / 100)}
        />
        <MetricCard
          title="آخر تحديث مصدر (الرياض)"
          value={data.freshness.lastSourceUpdatedAtRiyadh ?? "—"}
        />
      </div>

      <DistributionCard
        title="توزيع مصدر الورود (sourceOrigin)"
        description="لا يُدمج مع توزيع القنوات"
        items={data.sourceOrigin.items.slice(0, 12)}
        hrefFor={(item) => drillDownHref(base, item.drillDownFilters)}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <DistributionCard
          title="الحالة المصدرية"
          description="مستقلة عن status الداخلي"
          items={data.sourceStatus.items}
          hrefFor={(item) => drillDownHref(base, item.drillDownFilters)}
        />
        <DistributionCard
          title="حالة الإجراء المصدرية"
          description="مستقلة عن الحالة الداخلية"
          items={data.sourceActionStatus.items}
          hrefFor={(item) => drillDownHref(base, item.drillDownFilters)}
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">جودة قيم الإجراء (actionTaken)</CardTitle>
          <CardDescription>
            تحليل جودة فقط — بلا قاموس دائم. actionDescription لا يُجمَّع كتصنيف.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">غير فارغ: {formatNumber(data.actionTakenQuality.nonEmptyCount)}</Badge>
            <Badge variant="secondary">فارغ: {formatNumber(data.actionTakenQuality.emptyCount)}</Badge>
            <Badge variant="secondary">فريد: {formatNumber(data.actionTakenQuality.uniqueCount)}</Badge>
            <Badge variant="secondary">نادر: {formatPercent(data.actionTakenQuality.rareValueShare / 100)}</Badge>
          </div>
          <ul className="space-y-1">
            {data.actionTakenQuality.topNormalized.slice(0, 8).map((row) => (
              <li key={row.label} className="flex justify-between gap-2">
                <span className="truncate">{row.label}</span>
                <span className="text-muted-foreground">{formatNumber(row.count)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <DistributionCard
        title="تحليل أولي للأجنحة (wingCode)"
        description="أساس تحليلي مبدئي — ليست شاشة Issue #36 الكاملة"
        items={data.wing.items.slice(0, 15).map((w) => ({
          key: w.key,
          label: w.label,
          count: w.count,
          percentage: w.percentage,
          open: w.open,
          closed: w.closed,
          currentlyLate: w.currentlyLate,
          averageResolutionDays: null,
          previousCount: null,
          change: null,
          drillDownFilters: w.drillDownFilters,
        }))}
        hrefFor={(item) => drillDownHref(base, item.drillDownFilters)}
        footnote={`غير محدد: ${formatNumber(data.wing.unspecifiedCount)}`}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">حداثة البيانات</CardTitle>
          <CardDescription>العرض بتوقيت Asia/Riyadh دون تغيير القيم المخزنة</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.freshness.buckets.map((bucket) => (
            <div key={bucket.bucket} className="flex items-center justify-between gap-2 text-sm">
              <span>{bucket.label}</span>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {formatNumber(bucket.count)} ({formatPercent(bucket.percentage / 100)})
                </span>
                <Button asChild size="sm" variant="ghost">
                  <a href={drillDownHref(base, bucket.drillDownFilters)}>عرض</a>
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">مؤشرات جودة البيانات</CardTitle>
          <CardDescription>بدون طباعة نصوص الشكاوى أو أسماء المستخدمين</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.dataQuality.map((signal) => (
            <div key={signal.id} className="flex items-start justify-between gap-3 rounded-md border p-2 text-sm">
              <div>
                <div className="font-medium">{signal.label}</div>
                <div className="text-muted-foreground">{signal.explanation}</div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge variant={signal.severity === "critical" ? "destructive" : "secondary"}>
                  {formatNumber(signal.count)}
                </Badge>
                {Object.keys(signal.drillDownFilters).length > 0 && (
                  <Button asChild size="sm" variant="ghost">
                    <a href={drillDownHref(base, signal.drillDownFilters)}>عرض</a>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {data.staffActors.enabled === false && (
        <p className="text-xs text-muted-foreground">
          تحليل sourceClosedBy / sourceUpdatedBy معطّل في الواجهة العامة (
          {data.staffActors.reason}).
        </p>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
}>) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="الكل" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">الكل</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.id || OPERATIONAL_UNSPECIFIED} value={opt.id}>
              {opt.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function MetricCard({ title, value }: Readonly<{ title: string; value: string }>) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function DistributionCard({
  title,
  description,
  items,
  hrefFor,
  footnote,
}: Readonly<{
  title: string;
  description: string;
  items: Array<{
    key: string;
    label: string;
    count: number;
    percentage: number;
    open: number;
    closed: number;
    currentlyLate: number;
    drillDownFilters: Record<string, string>;
  }>;
  hrefFor: (item: {
    key: string;
    label: string;
    count: number;
    percentage: number;
    open: number;
    closed: number;
    currentlyLate: number;
    drillDownFilters: Record<string, string>;
  }) => string;
  footnote?: string;
}>) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium">{item.label}</div>
              <div className="text-xs text-muted-foreground">
                مفتوح {formatNumber(item.open)} · مغلق {formatNumber(item.closed)} · متأخر{" "}
                {formatNumber(item.currentlyLate)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span>
                {formatNumber(item.count)} ({formatPercent(item.percentage / 100)})
              </span>
              <Button asChild size="sm" variant="ghost">
                <a href={hrefFor(item)}>عرض</a>
              </Button>
            </div>
          </div>
        ))}
        {footnote ? <p className="text-xs text-muted-foreground">{footnote}</p> : null}
      </CardContent>
    </Card>
  );
}
