"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import {
  Users, Repeat2, Building2, ExternalLink, ChevronDown, ChevronLeft,
  AlertTriangle, ArrowUpDown, Flame, Radio, TrendingUp,
} from "lucide-react";
import { formatNumber, formatPercent } from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";
import { isRecord, readJsonResponse, apiErrorMessage } from "@/lib/analytics/analytics-api-contract";
import {
  isRepeatComplainantSummaryData,
  isRepeatComplainantPeopleData,
  buildRepeatComplainantDrilldownQuery,
  type RepeatComplainantSummaryData,
  type RepeatComplainantPeopleData,
} from "@/lib/analytics/repeat-complainant-api-contract";
import { UNCLASSIFIED_CLASSIFICATION_KEY } from "@/lib/reports/classification-keys";
import type { RepeatFacilitySummaryRow, RepeatPersonRow } from "@/lib/analytics/repeat-complainant-directory";

export type { RepeatComplainantSummaryData };

type Props = Readonly<{
  from: string;
  to: string;
  regionId: string;
  onNavigateToExplorer?: (query: Record<string, string>) => void;
}>;

type FacilitySortKey = "repeatedPeopleCount" | "repeatedComplaintsCount" | "repeatRatePercent" | "highestRepeatByOnePerson";

const SORT_OPTIONS: { key: FacilitySortKey; label: string }[] = [
  { key: "repeatedPeopleCount", label: "عدد الأشخاص المكررين" },
  { key: "repeatedComplaintsCount", label: "إجمالي الشكاوى المتكررة" },
  { key: "repeatRatePercent", label: "نسبة التكرار" },
  { key: "highestRepeatByOnePerson", label: "أعلى تكرار لشخص واحد" },
];

const PRIORITY_BAND_LABELS: Record<string, string> = { HIGH: "مرتفعة", MEDIUM: "متوسطة", LOW: "منخفضة" };
const PRIORITY_BAND_CLASSES: Record<string, string> = {
  HIGH: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  MEDIUM: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  LOW: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const PATTERN_LABELS: Record<string, string> = { CONCENTRATED: "تكرار مركز", DIVERSE: "تكرار متعدد الأنواع" };

type PeopleCacheEntry = { loading: boolean; error: string | null; data: RepeatComplainantPeopleData | null };

function DrillButton({ onClick, label = "عرض الشكاوى" }: Readonly<{ onClick: () => void; label?: string }>) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1 px-2 text-xs"
      onClick={(event) => {
        // Drill buttons always live inside a clickable table row (which
        // toggles expansion) — stop propagation here once, so every call
        // site can pass a plain zero-argument callback.
        event.stopPropagation();
        onClick();
      }}
    >
      <ExternalLink className="h-3 w-3" />
      {label}
    </Button>
  );
}

function KpiCard({
  icon, label, value, sub,
}: Readonly<{ icon: React.ReactNode; label: string; value: string; sub?: string }>) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{label}</p>
          <p className="text-lg font-bold truncate">{value}</p>
          {sub && <p className="text-[11px] text-muted-foreground truncate">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function PersonTypeBreakdown({ person }: Readonly<{ person: RepeatPersonRow }>) {
  return (
    <ul className="space-y-1 text-xs">
      {person.topComplaintTypes.map((type) => (
        <li key={type.classificationId} className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground truncate">{type.label}</span>
          <span className="font-semibold">{formatNumber(type.count)}</span>
        </li>
      ))}
    </ul>
  );
}

function PersonRowDetail({
  person, onNavigateToExplorer, from, to,
}: Readonly<{
  person: RepeatPersonRow;
  onNavigateToExplorer?: (query: Record<string, string>) => void;
  from: string;
  to: string;
}>) {
  const [expanded, setExpanded] = useState(false);
  return (
    <TableRow>
      <TableCell colSpan={7} className="bg-muted/30 p-0">
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-2 text-sm font-medium hover:underline"
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
              <span className="font-mono">{person.complainantIdentifierMasked}</span>
              <Badge variant="outline" className="text-[10px]">{PATTERN_LABELS[person.pattern]}</Badge>
              {person.spansMultiplePeriods && (
                <Badge variant="outline" className="text-[10px]">تكرار عبر فترات</Badge>
              )}
            </button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>الشكاوى: <strong className="text-foreground">{formatNumber(person.totalComplaints)}</strong></span>
              <span>الأنواع: <strong className="text-foreground">{formatNumber(person.distinctComplaintTypesCount)}</strong></span>
              {person.sameTypeRepeatCount >= 2 && (
                <span>تكرار بنفس النوع: <strong className="text-foreground">{formatNumber(person.sameTypeRepeatCount)}</strong></span>
              )}
              <span>آخر شكوى: <strong className="text-foreground">{person.lastComplaintDate}</strong></span>
              {onNavigateToExplorer && (
                <DrillButton
                  onClick={() =>
                    onNavigateToExplorer(
                      buildRepeatComplainantDrilldownQuery(person.drilldownFilters, { from, to })
                    )
                  }
                />
              )}
            </div>
          </div>
          {expanded && (
            <div className="max-w-sm">
              <PersonTypeBreakdown person={person} />
              {onNavigateToExplorer && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {person.topComplaintTypes
                    .filter((t) => t.classificationId !== UNCLASSIFIED_CLASSIFICATION_KEY)
                    .map((t) => (
                      <Button
                        key={t.classificationId}
                        variant="outline"
                        size="sm"
                        className="h-6 gap-1 px-2 text-[11px]"
                        onClick={() =>
                          onNavigateToExplorer(
                            buildRepeatComplainantDrilldownQuery(
                              { ...person.drilldownFilters, classificationId: t.classificationId },
                              { from, to }
                            )
                          )
                        }
                      >
                        {t.label}
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function FacilityBadges({ row }: Readonly<{ row: RepeatFacilitySummaryRow }>) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.linkedChronicIssue && (
        <Badge variant="outline" className="gap-1 text-[10px] text-orange-700 dark:text-orange-300">
          <Flame className="h-3 w-3" /> مشكلة مزمنة
        </Badge>
      )}
      {row.linkedMassComplaint && (
        <Badge variant="outline" className="gap-1 text-[10px] text-purple-700 dark:text-purple-300">
          <Radio className="h-3 w-3" /> انتشار جماعي
        </Badge>
      )}
      {row.linkedHighPriorityFacility && (
        <Badge variant="outline" className="gap-1 text-[10px] text-red-700 dark:text-red-300">
          <TrendingUp className="h-3 w-3" /> أولوية مرتفعة
        </Badge>
      )}
    </div>
  );
}

export function RepeatComplainantsPanel({ from, to, regionId, onNavigateToExplorer }: Props) {
  const [summary, setSummary] = useState<RepeatComplainantSummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [minComplaints, setMinComplaints] = useState("2");
  const [sameTypeOnly, setSameTypeOnly] = useState(false);
  const [topFacilities, setTopFacilities] = useState("15");
  const [sortKey, setSortKey] = useState<FacilitySortKey>("repeatedPeopleCount");

  const [expandedFacility, setExpandedFacility] = useState<string | null>(null);
  const [peopleCache, setPeopleCache] = useState<Record<string, PeopleCacheEntry>>({});

  const requestRef = useRef(0);

  const buildBaseParams = useCallback(() => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (regionId && regionId !== "all") params.set("regionId", regionId);
    if (minComplaints) params.set("minComplaints", minComplaints);
    if (sameTypeOnly) params.set("sameTypeOnly", "true");
    if (topFacilities) params.set("topFacilities", topFacilities);
    return params;
  }, [from, to, regionId, minComplaints, sameTypeOnly, topFacilities]);

  const loadSummary = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      setLoading(true);
      setError(null);
      try {
        const params = buildBaseParams();
        const res = await fetch(`/api/analytics/repeat-complainants?${params.toString()}`, { signal });
        const payload = await readJsonResponse(res);
        if (!res.ok) throw new Error(apiErrorMessage(payload, "تعذر تحميل تحليل تكرار الشكاوى."));
        if (!isRepeatComplainantSummaryData(payload)) throw new Error("استجابة تحليل التكرار غير مكتملة.");
        if (!signal?.aborted && requestRef.current === requestId) {
          setSummary(payload);
        }
      } catch (e) {
        if (isAbortError(e)) return;
        if (requestRef.current === requestId) {
          setSummary(null);
          setError(e instanceof Error ? e.message : "تعذر تحميل تحليل تكرار الشكاوى.");
        }
      } finally {
        if (!signal?.aborted && requestRef.current === requestId) setLoading(false);
      }
    },
    [buildBaseParams]
  );

  useEffect(() => {
    const controller = new AbortController();
    setExpandedFacility(null);
    setPeopleCache({});
    void loadSummary(controller.signal);
    return () => controller.abort();
  }, [loadSummary]);

  const toggleFacility = useCallback(
    (facility: string) => {
      if (expandedFacility === facility) {
        setExpandedFacility(null);
        return;
      }
      setExpandedFacility(facility);
      const existing = peopleCache[facility];
      if (existing?.data || existing?.loading) return;

      setPeopleCache((prev) => ({ ...prev, [facility]: { loading: true, error: null, data: null } }));
      (async () => {
        try {
          const params = buildBaseParams();
          params.set("facility", facility);
          params.set("pageSize", "25");
          params.set("page", "1");
          const res = await fetch(`/api/analytics/repeat-complainants/people?${params.toString()}`);
          const payload = await readJsonResponse(res);
          if (!res.ok) throw new Error(apiErrorMessage(payload, "تعذر تحميل قائمة الأشخاص."));
          if (!isRepeatComplainantPeopleData(payload)) throw new Error("استجابة قائمة الأشخاص غير مكتملة.");
          setPeopleCache((prev) => ({ ...prev, [facility]: { loading: false, error: null, data: payload } }));
        } catch (e) {
          if (isAbortError(e)) return;
          setPeopleCache((prev) => ({
            ...prev,
            [facility]: { loading: false, error: e instanceof Error ? e.message : "تعذر تحميل قائمة الأشخاص.", data: null },
          }));
        }
      })();
    },
    [expandedFacility, peopleCache, buildBaseParams]
  );

  const sortedFacilities = useMemo(() => {
    const rows = summary?.facilities ?? [];
    return [...rows].sort((a, b) => b[sortKey] - a[sortKey]);
  }, [summary, sortKey]);

  const chartData = useMemo(
    () =>
      sortedFacilities.slice(0, 10).map((row) => ({
        facility: row.facility,
        عدد_الأشخاص_المكررين: row.repeatedPeopleCount,
      })),
    [sortedFacilities]
  );

  if (loading && !summary) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {["kpi-1", "kpi-2", "kpi-3", "kpi-4", "kpi-5"].map((key) => (
          <Skeleton key={key} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error && !summary) {
    return (
      <Card className="border-destructive/50 bg-destructive/5" role="alert">
        <CardContent className="flex items-center gap-3 py-4">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
          <p className="text-sm">{error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!summary) return null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">تكرار الشكاوى من نفس الشخص</h3>
        <p className="text-xs text-muted-foreground">
          تحليل الأشخاص الذين قدموا أكثر من شكوى، وأكثر السجون التي يظهر فيها هذا النمط.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard
          icon={<Users className="h-5 w-5" />}
          label="عدد الأشخاص المكررين"
          value={formatNumber(summary.kpis.repeatedPeopleCount)}
        />
        <KpiCard
          icon={<Repeat2 className="h-5 w-5" />}
          label="إجمالي الشكاوى المتكررة"
          value={formatNumber(summary.kpis.repeatedComplaintsCount)}
        />
        <KpiCard
          icon={<ArrowUpDown className="h-5 w-5" />}
          label="نسبة الشكاوى المتكررة من الإجمالي"
          value={formatPercent(summary.kpis.repeatedShareOfPeriodPercent)}
        />
        <KpiCard
          icon={<Building2 className="h-5 w-5" />}
          label="السجن الأعلى في عدد الأشخاص المكررين"
          value={summary.kpis.topFacility?.facility ?? "—"}
          sub={summary.kpis.topFacility ? `${formatNumber(summary.kpis.topFacility.repeatedPeopleCount)} شخص` : undefined}
        />
        <KpiCard
          icon={<Flame className="h-5 w-5" />}
          label="أكثر نوع شكوى متكرر"
          value={summary.kpis.topComplaintType?.label ?? "—"}
          sub={summary.kpis.topComplaintType ? `${formatNumber(summary.kpis.topComplaintType.count)} شكوى` : undefined}
        />
      </div>

      {/* Executive conclusions */}
      {summary.conclusions.length > 0 && (
        <Card>
          <CardContent className="py-3">
            <ul className="space-y-1 text-sm">
              {summary.conclusions.map((line) => (
                <li key={line} className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Local filters */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 py-4">
          <div className="space-y-1">
            <Label htmlFor="rc-min-complaints" className="text-xs">الحد الأدنى لعدد شكاوى الشخص</Label>
            <Input
              id="rc-min-complaints"
              type="number"
              min={2}
              value={minComplaints}
              onChange={(e) => setMinComplaints(e.target.value)}
              className="h-8 w-24"
            />
          </div>
          <div className="flex items-center gap-2 pb-1.5">
            <Checkbox
              id="rc-same-type-only"
              checked={sameTypeOnly}
              onCheckedChange={(checked) => setSameTypeOnly(checked === true)}
            />
            <Label htmlFor="rc-same-type-only" className="text-xs font-normal">نفس النوع فقط</Label>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rc-top-facilities" className="text-xs">أعلى X سجون</Label>
            <Select value={topFacilities} onValueChange={setTopFacilities}>
              <SelectTrigger id="rc-top-facilities" className="h-8 w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["5", "10", "15", "25", "50"].map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rc-sort" className="text-xs">ترتيب السجون حسب</Label>
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as FacilitySortKey)}>
              <SelectTrigger id="rc-sort" className="h-8 w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Top facilities chart */}
      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">أكثر السجون في عدد الأشخاص المكررين</CardTitle>
            <CardDescription className="text-xs">انقر على أي عمود لعرض تفاصيل السجن أدناه</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" allowDecimals={false} />
                <YAxis type="category" dataKey="facility" width={140} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar
                  dataKey="عدد_الأشخاص_المكررين"
                  fill="#0f766e"
                  radius={[0, 4, 4, 0]}
                  cursor="pointer"
                  onClick={(data: unknown) => {
                    const facility = isRecord(data) && typeof data.facility === "string" ? data.facility : null;
                    if (facility) toggleFacility(facility);
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Facility table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">أكثر السجون التي يوجد بها تكرار شكاوى</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>المنطقة</TableHead>
                <TableHead>السجن</TableHead>
                <TableHead>الأشخاص المكررون</TableHead>
                <TableHead>إجمالي الشكاوى</TableHead>
                <TableHead>نسبة التكرار</TableHead>
                <TableHead>أكثر نوع متكرر</TableHead>
                <TableHead>الأولوية</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedFacilities.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                    لا يوجد تكرار شكاوى للفترة والفلاتر الحالية.
                  </TableCell>
                </TableRow>
              )}
              {sortedFacilities.map((row) => {
                const isExpanded = expandedFacility === row.facility;
                const peopleEntry = peopleCache[row.facility];
                return (
                  <Fragment key={row.facility}>
                    <TableRow
                      key={row.facility}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => toggleFacility(row.facility)}
                    >
                      <TableCell className="text-muted-foreground">{row.region}</TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-1.5">
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                          {row.facility}
                        </div>
                        <FacilityBadges row={row} />
                      </TableCell>
                      <TableCell>{formatNumber(row.repeatedPeopleCount)}</TableCell>
                      <TableCell>
                        {formatNumber(row.repeatedComplaintsCount)}
                        <span className="text-muted-foreground text-xs"> / {formatNumber(row.facilityTotalComplaints)}</span>
                      </TableCell>
                      <TableCell>{formatPercent(row.repeatRatePercent)}</TableCell>
                      <TableCell className="max-w-[160px] truncate">
                        {row.topComplaintType
                          ? `${row.topComplaintType.label} (${formatNumber(row.topComplaintType.count)})`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge className={PRIORITY_BAND_CLASSES[row.priorityBand]}>
                            {PRIORITY_BAND_LABELS[row.priorityBand] ?? row.priorityBand}
                          </Badge>
                          {onNavigateToExplorer && (
                            <DrillButton
                              onClick={() =>
                                onNavigateToExplorer(
                                  buildRepeatComplainantDrilldownQuery(row.drilldownFilters, { from, to })
                                )
                              }
                            />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow key={`${row.facility}-detail`}>
                        <TableCell colSpan={7} className="p-0">
                          {peopleEntry?.loading && (
                            <div className="p-4"><Skeleton className="h-20 w-full" /></div>
                          )}
                          {peopleEntry?.error && (
                            <p className="p-4 text-sm text-destructive">{peopleEntry.error}</p>
                          )}
                          {peopleEntry?.data && peopleEntry.data.people.length === 0 && (
                            <p className="p-4 text-sm text-muted-foreground">لا يوجد أشخاص مكررون ضمن الفلاتر الحالية.</p>
                          )}
                          {peopleEntry?.data && peopleEntry.data.people.length > 0 && (
                            <Table>
                              <TableBody>
                                {peopleEntry.data.people.map((person) => (
                                  <PersonRowDetail
                                    key={person.complainantIdentifierRaw}
                                    person={person}
                                    onNavigateToExplorer={onNavigateToExplorer}
                                    from={from}
                                    to={to}
                                  />
                                ))}
                              </TableBody>
                            </Table>
                          )}
                          {peopleEntry?.data && peopleEntry.data.total > peopleEntry.data.people.length && (
                            <p className="px-4 pb-3 text-xs text-muted-foreground">
                              عرض {formatNumber(peopleEntry.data.people.length)} من {formatNumber(peopleEntry.data.total)} شخص.
                            </p>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
