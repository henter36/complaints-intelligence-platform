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
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Accordion, AccordionItem, AccordionTrigger, AccordionContent,
} from "@/components/ui/accordion";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import {
  Users, Repeat2, Building2, ExternalLink, ChevronDown, ChevronLeft,
  AlertTriangle, ArrowUpDown, Flame, Radio, TrendingUp, Search, Eye, EyeOff,
  FileDown, X, Sparkles,
} from "lucide-react";
import { formatNumber, formatPercent } from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";
import { isRecord, readJsonResponse, apiErrorMessage } from "@/lib/analytics/analytics-api-contract";
import {
  isRepeatComplainantSummaryData,
  isRepeatComplainantPeopleData,
  isRepeatComplainantSearchData,
  isRepeatComplainantPersonDetail,
  buildRepeatComplainantDrilldownQuery,
  type RepeatComplainantSummaryData,
  type RepeatComplainantPeopleData,
} from "@/lib/analytics/repeat-complainant-api-contract";
import type { RepeatFacilitySummaryRow } from "@/lib/analytics/repeat-complainant-directory";
// Types only — erased at compile time, no server runtime reaches the client bundle.
import type { RepeatPersonRowForClient } from "@/server/analytics/repeat-complainants/repeat-complainant-analytics-service";
import type {
  RepeatComplainantPersonDetail,
  PersonDetailSortOrder,
} from "@/server/analytics/repeat-complainants/repeat-complainant-person-detail-service";

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

type PeopleSortKey = "totalComplaints" | "lastComplaintDate" | "distinctComplaintTypesCount" | "sameTypeRepeatCount";

const PEOPLE_SORT_OPTIONS: { key: PeopleSortKey; label: string }[] = [
  { key: "totalComplaints", label: "عدد الشكاوى" },
  { key: "lastComplaintDate", label: "آخر شكوى" },
  { key: "distinctComplaintTypesCount", label: "عدد الأنواع" },
  { key: "sameTypeRepeatCount", label: "تكرار بنفس النوع" },
];

const PEOPLE_SORT_COMPARATORS: Record<PeopleSortKey, (a: RepeatPersonRowForClient, b: RepeatPersonRowForClient) => number> = {
  totalComplaints: (a, b) => b.totalComplaints - a.totalComplaints,
  lastComplaintDate: (a, b) => b.lastComplaintDate.localeCompare(a.lastComplaintDate),
  distinctComplaintTypesCount: (a, b) => b.distinctComplaintTypesCount - a.distinctComplaintTypesCount,
  sameTypeRepeatCount: (a, b) => b.sameTypeRepeatCount - a.sameTypeRepeatCount,
};

const PRIORITY_BAND_LABELS: Record<string, string> = { HIGH: "مرتفعة", MEDIUM: "متوسطة", LOW: "منخفضة" };
const PRIORITY_BAND_CLASSES: Record<string, string> = {
  HIGH: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  MEDIUM: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  LOW: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const PATTERN_LABELS: Record<string, string> = { CONCENTRATED: "تكرار مركز", DIVERSE: "تكرار متعدد الأنواع" };

/**
 * Analytical descriptions of the DATA, never a judgment about the person
 * (spec). Duplicated (not imported) from the PDF service's own
 * `patternDescription` on purpose — that module pulls in `node:crypto` +
 * PDFKit at runtime, which must never reach the client bundle.
 */
function patternDescription(person: RepeatPersonRowForClient): string {
  const parts: string[] = [
    person.pattern === "CONCENTRATED" ? "تكرار مركز في تصنيف واحد بشكل رئيسي" : "تكرار متعدد الأنواع عبر عدة تصنيفات",
  ];
  if (person.spansMultiplePeriods) parts.push("مستمر عبر أكثر من فترة قياس");
  if (person.recentActivity) parts.push("نشاط حديث (معظم الشكاوى في آخر فترة)");
  return parts.join(" — ");
}

type PeopleCacheEntry = { loading: boolean; error: string | null; data: RepeatComplainantPeopleData | null };
/** `facility: null` means "org-wide" (spec §12) — every complaint of this person across every facility they appear at, not just the one their row was opened from. */
type SelectedPerson = { token: string; facility: string | null };
type PersonDetailState = { loading: boolean; error: string | null; data: RepeatComplainantPersonDetail | null };

function DrillButton({ onClick, label = "عرض الشكاوى" }: Readonly<{ onClick: () => void; label?: string }>) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1 px-2 text-xs"
      onClick={(event) => {
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

/**
 * Shows the masked identifier by default; the raw value is fetched ONLY on
 * an explicit click (never preloaded, never cached beyond this component's
 * own state, never written to the URL — spec's reveal-toggle requirement).
 */
function IdentityCell({ person }: Readonly<{ person: RepeatPersonRowForClient }>) {
  const [revealed, setRevealed] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Cancels an in-flight reveal fetch on unmount (e.g. the person's Sheet
  // closes, or their row scrolls out of a re-rendered list) so a late
  // response never calls setState on an unmounted cell.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const toggle = useCallback(async () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (value) {
      setRevealed(true);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/analytics/repeat-complainants/reveal?token=${encodeURIComponent(person.complainantToken)}`, {
        signal: controller.signal,
      });
      const payload = await readJsonResponse(res);
      if (!res.ok || !isRecord(payload) || typeof payload.identifier !== "string") {
        throw new Error("failed");
      }
      if (controller.signal.aborted) return;
      setValue(payload.identifier);
      setRevealed(true);
    } catch (e) {
      if (isAbortError(e) || controller.signal.aborted) return;
      setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [revealed, value, person.complainantToken]);

  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-xs">{revealed && value ? value : person.complainantIdentifierMasked}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        disabled={loading}
        onClick={(e) => {
          e.stopPropagation();
          void toggle();
        }}
        title={revealed ? "إخفاء الهوية" : "إظهار الهوية"}
      >
        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
      {error && <span className="text-[10px] text-destructive">تعذر الإظهار</span>}
    </div>
  );
}

function PersonPatternBadges({ person }: Readonly<{ person: RepeatPersonRowForClient }>) {
  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant="outline" className="text-[10px]">{PATTERN_LABELS[person.pattern]}</Badge>
      {person.spansMultiplePeriods && <Badge variant="outline" className="text-[10px]">مستمر عبر فترات</Badge>}
      {person.recentActivity && (
        <Badge variant="outline" className="gap-1 text-[10px] text-blue-700 dark:text-blue-300">
          <Sparkles className="h-3 w-3" /> نشاط حديث
        </Badge>
      )}
    </div>
  );
}

/** One row of the spec's main person table: الاسم|الهوية|المنطقة|السجن|عدد الشكاوى|أنواع الشكاوى|الأكثر تكراراً|آخر شكوى|التفاصيل */
function PersonTableRow({
  person, onOpenDetail, scopeToFacility,
}: Readonly<{
  person: RepeatPersonRowForClient;
  onOpenDetail: (selection: SelectedPerson) => void;
  /** true inside a facility-expanded list (every row genuinely belongs to just that facility); false for org-wide search results, where opening org-wide detail (not just this person's primary facility) is the honest scope. */
  scopeToFacility: boolean;
}>) {
  const topType = person.topComplaintTypes[0];
  return (
    <TableRow>
      <TableCell className="font-medium">{person.complainantName ?? "غير متوفر"}</TableCell>
      <TableCell><IdentityCell person={person} /></TableCell>
      <TableCell className="text-muted-foreground">{person.region}</TableCell>
      <TableCell className="max-w-[160px] truncate">
        {person.facilitiesCount > 1 ? `${person.facility} (+${formatNumber(person.facilitiesCount - 1)})` : person.facility}
      </TableCell>
      <TableCell>{formatNumber(person.totalComplaints)}</TableCell>
      <TableCell>{formatNumber(person.distinctComplaintTypesCount)}</TableCell>
      <TableCell className="max-w-[140px] truncate">{topType ? `${topType.label} (${formatNumber(topType.count)})` : "—"}</TableCell>
      <TableCell className="text-muted-foreground">{person.lastComplaintDate}</TableCell>
      <TableCell>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onOpenDetail({ token: person.complainantToken, facility: scopeToFacility ? person.facility : null })}
        >
          عرض التكرارات
        </Button>
      </TableCell>
    </TableRow>
  );
}

function PeopleTable({
  people, onOpenDetail, emptyMessage, scopeToFacility,
}: Readonly<{
  people: RepeatPersonRowForClient[];
  onOpenDetail: (selection: SelectedPerson) => void;
  emptyMessage: string;
  scopeToFacility: boolean;
}>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>الاسم</TableHead>
          <TableHead>الهوية</TableHead>
          <TableHead>المنطقة</TableHead>
          <TableHead>السجن</TableHead>
          <TableHead>عدد الشكاوى</TableHead>
          <TableHead>أنواع الشكاوى</TableHead>
          <TableHead>الأكثر تكراراً</TableHead>
          <TableHead>آخر شكوى</TableHead>
          <TableHead>التفاصيل</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {people.length === 0 && (
          <TableRow>
            <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-8">
              {emptyMessage}
            </TableCell>
          </TableRow>
        )}
        {people.map((person) => (
          <PersonTableRow key={person.complainantToken} person={person} onOpenDetail={onOpenDetail} scopeToFacility={scopeToFacility} />
        ))}
      </TableBody>
    </Table>
  );
}

function PersonDetailContent({
  detail, selectedFacility, sortOrder, onSortOrderChange, includeFullIdentifier, onIncludeFullIdentifierChange,
  onExport, exporting, onNavigateToExplorer, from, to,
}: Readonly<{
  detail: RepeatComplainantPersonDetail;
  /** The facility this detail view was opened FROM (or null when opened org-wide) — drives the optional "شكاواه في هذا السجن" second drill button, independent of how many facilities the person actually appears at. */
  selectedFacility: string | null;
  sortOrder: PersonDetailSortOrder;
  onSortOrderChange: (order: PersonDetailSortOrder) => void;
  includeFullIdentifier: boolean;
  onIncludeFullIdentifierChange: (checked: boolean) => void;
  onExport: () => void;
  exporting: boolean;
  onNavigateToExplorer?: (query: Record<string, string>) => void;
  from: string;
  to: string;
}>) {
  const { person } = detail;
  const isMultiFacility = person.facilitiesCount > 1;
  const chartData = useMemo(
    () => detail.timeline.map((point) => ({ label: point.monthLabel, عدد_الشكاوى: point.count })),
    [detail.timeline]
  );

  return (
    <div className="space-y-5 px-5 py-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">{person.complainantName ?? "غير متوفر"}</span>
          <IdentityCell person={person} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>المنطقة: <strong className="text-foreground">{isMultiFacility ? "عدة مناطق" : person.region}</strong></span>
          <span>
            السجن:{" "}
            <strong className="text-foreground">
              {isMultiFacility ? `ظهر في ${formatNumber(person.facilitiesCount)} سجون` : person.facility}
            </strong>
          </span>
          <span>إجمالي الشكاوى: <strong className="text-foreground">{formatNumber(person.totalComplaints)}</strong></span>
          <span>عدد الأنواع: <strong className="text-foreground">{formatNumber(person.distinctComplaintTypesCount)}</strong></span>
        </div>
        <PersonPatternBadges person={person} />
        {onNavigateToExplorer && (
          <div className="flex flex-wrap gap-2">
            <DrillButton
              label="عرض كل شكاوى هذا الشخص"
              onClick={() =>
                onNavigateToExplorer(
                  buildRepeatComplainantDrilldownQuery({ complainantToken: person.complainantToken }, { from, to })
                )
              }
            />
            {/* Only meaningful (and only shown) when it would actually narrow the
                result vs. the org-wide button above — i.e. the person appears at
                more than one facility AND this sheet was opened from a specific one. */}
            {isMultiFacility && selectedFacility && (
              <DrillButton
                label={`عرض شكاواه في ${selectedFacility}`}
                onClick={() =>
                  onNavigateToExplorer(
                    buildRepeatComplainantDrilldownQuery(
                      { complainantToken: person.complainantToken, facility: selectedFacility },
                      { from, to }
                    )
                  )
                }
              />
            )}
          </div>
        )}
      </div>

      {isMultiFacility && (
        <div className="space-y-1.5">
          <h4 className="text-sm font-semibold">توزيع الشكاوى حسب السجن</h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>السجن</TableHead>
                <TableHead>المنطقة</TableHead>
                <TableHead>عدد الشكاوى</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {person.facilities.map((f) => (
                <TableRow key={f.facility}>
                  <TableCell>{f.facility}</TableCell>
                  <TableCell className="text-muted-foreground">{f.region}</TableCell>
                  <TableCell>{formatNumber(f.complaintsCount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="space-y-1.5">
        <h4 className="text-sm font-semibold">ملخص التكرار</h4>
        <p className="text-xs text-muted-foreground">{patternDescription(person)}</p>
      </div>

      <div className="space-y-1.5">
        <h4 className="text-sm font-semibold">توزيع أنواع الشكاوى</h4>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>النوع</TableHead>
              <TableHead>العدد</TableHead>
              <TableHead>النسبة</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {person.topComplaintTypes.map((type) => (
              <TableRow key={type.classificationId}>
                <TableCell>{type.label}</TableCell>
                <TableCell>{formatNumber(type.count)}</TableCell>
                <TableCell>
                  {person.totalComplaints > 0 ? formatPercent(Math.round((type.count / person.totalComplaints) * 1000) / 10) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {chartData.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-sm font-semibold">التسلسل الزمني</h4>
          <ResponsiveContainer width="100%" height={Math.max(120, chartData.length * 32)}>
            <BarChart data={chartData} layout="vertical" margin={{ left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" allowDecimals={false} />
              <YAxis type="category" dataKey="label" width={90} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="عدد_الشكاوى" fill="#0f766e" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">كل الشكاوى (مرتبة زمنياً)</h4>
          <Select value={sortOrder} onValueChange={(v) => onSortOrderChange(v as PersonDetailSortOrder)}>
            <SelectTrigger className="h-7 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">الأحدث أولاً</SelectItem>
              <SelectItem value="asc">الأقدم أولاً</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>رقم الشكوى</TableHead>
              <TableHead>التاريخ</TableHead>
              <TableHead>التصنيف</TableHead>
              <TableHead>الموضوع</TableHead>
              <TableHead>الحالة</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.complaints.map((c) => (
              <TableRow key={c.complaintId}>
                <TableCell className="font-mono text-xs">{c.complaintNumber}</TableCell>
                <TableCell className="text-xs">{c.date}</TableCell>
                <TableCell className="text-xs">{c.classificationLabel}</TableCell>
                <TableCell className="max-w-[220px] truncate text-xs">{c.subject}</TableCell>
                <TableCell className="text-xs">{c.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-1.5">
        <h4 className="text-sm font-semibold">الشكاوى مجمعة حسب النوع</h4>
        <Accordion type="multiple" className="w-full">
          {detail.complaintsByType.map((group) => (
            <AccordionItem key={group.classificationId} value={group.classificationId}>
              <AccordionTrigger className="text-xs">
                {group.label} ({formatNumber(group.complaints.length)})
              </AccordionTrigger>
              <AccordionContent>
                <ul className="space-y-1">
                  {group.complaints.map((c) => (
                    <li key={c.complaintId} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate">{c.subject}</span>
                      <span className="shrink-0 text-muted-foreground">{c.date}</span>
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>

      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="rc-person-full-id"
            checked={includeFullIdentifier}
            onCheckedChange={(checked) => onIncludeFullIdentifierChange(checked === true)}
          />
          <Label htmlFor="rc-person-full-id" className="text-xs font-normal">تضمين رقم الهوية كاملاً في تقرير PDF</Label>
        </div>
        {includeFullIdentifier && (
          <p className="flex items-start gap-1.5 text-[11px] text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            يحتوي التقرير على بيانات شخصية تعريفية. يجب التعامل معه وفق ضوابط الوصول والمشاركة المعتمدة.
          </p>
        )}
        <Button size="sm" className="gap-1.5" onClick={onExport} disabled={exporting}>
          <FileDown className="h-4 w-4" />
          {exporting ? "جارٍ إنشاء التقرير..." : "تصدير PDF لهذا الشخص"}
        </Button>
      </div>
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

  const [expandedRegions, setExpandedRegions] = useState<Set<string>>(new Set());
  const [expandedFacility, setExpandedFacility] = useState<string | null>(null);
  const [peopleCache, setPeopleCache] = useState<Record<string, PeopleCacheEntry>>({});
  const [peopleSortKey, setPeopleSortKey] = useState<PeopleSortKey>("totalComplaints");

  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RepeatPersonRowForClient[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selectedPerson, setSelectedPerson] = useState<SelectedPerson | null>(null);
  const [personDetail, setPersonDetail] = useState<PersonDetailState>({ loading: false, error: null, data: null });
  const [personSortOrder, setPersonSortOrder] = useState<PersonDetailSortOrder>("desc");
  const [personExportFull, setPersonExportFull] = useState(false);
  const [personExporting, setPersonExporting] = useState(false);

  const [bulkExportFull, setBulkExportFull] = useState(false);
  const [bulkExporting, setBulkExporting] = useState(false);

  const requestRef = useRef(0);
  const searchRequestRef = useRef(0);
  /** Cancels the in-flight per-facility people fetch — at most one at a time (only one facility can be expanded), reused across toggles/filter changes/unmount. */
  const peopleAbortRef = useRef<AbortController | null>(null);
  /** Generation counter for person-detail requests (open + sort-order reload share it) — the LAST request issued always wins, however its response and any earlier one's happen to resolve (spec §5/§6's A->B->response-B->response-A scenario). */
  const personRequestRef = useRef(0);
  const personAbortRef = useRef<AbortController | null>(null);

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
    // A period/region/local-filter change invalidates any in-flight
    // per-facility or per-person fetch issued under the OLD scope — without
    // this, a late response could resurrect stale data into the
    // just-cleared caches/sheet below (spec §5/§9's "period/region/filter
    // change" trigger list).
    peopleAbortRef.current?.abort();
    personAbortRef.current?.abort();
    setExpandedRegions(new Set());
    setExpandedFacility(null);
    setPeopleCache({});
    setSelectedPerson(null);
    setPersonDetail({ loading: false, error: null, data: null });
    setSearchInput("");
    setSearchQuery("");
    setSearchResults(null);
    void loadSummary(controller.signal);
    return () => controller.abort();
  }, [loadSummary]);

  // Unmount-only cleanup — cancels whatever facility/person fetch happens to
  // be in flight when the whole panel goes away (spec §5's "unmount" trigger).
  useEffect(
    () => () => {
      peopleAbortRef.current?.abort();
      personAbortRef.current?.abort();
    },
    []
  );

  // Debounced org-wide search — POST only (spec: a typed name/ID must never
  // land in the URL/browser history).
  useEffect(() => {
    const trimmed = searchInput.trim();
    const timer = setTimeout(() => setSearchQuery(trimmed), 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!searchQuery) {
      setSearchResults(null);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError(null);
    (async () => {
      try {
        const params = buildBaseParams();
        const body: Record<string, string> = { q: searchQuery };
        for (const [key, value] of params.entries()) body[key] = value;
        const res = await fetch("/api/analytics/repeat-complainants/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await readJsonResponse(res);
        if (!res.ok) throw new Error(apiErrorMessage(payload, "تعذر تنفيذ البحث."));
        if (!isRepeatComplainantSearchData(payload)) throw new Error("استجابة البحث غير مكتملة.");
        if (searchRequestRef.current === requestId) setSearchResults(payload.people);
      } catch (e) {
        if (isAbortError(e)) return;
        if (searchRequestRef.current === requestId) {
          setSearchResults(null);
          setSearchError(e instanceof Error ? e.message : "تعذر تنفيذ البحث.");
        }
      } finally {
        if (searchRequestRef.current === requestId) setSearchLoading(false);
      }
    })();
    return () => controller.abort();
  }, [searchQuery, buildBaseParams]);

  const toggleFacility = useCallback(
    (facility: string) => {
      // Only one facility is ever expanded at a time, so at most one
      // people-fetch should ever be in flight — closing one, or opening a
      // different one, always cancels whatever was still pending.
      peopleAbortRef.current?.abort();
      if (expandedFacility === facility) {
        setExpandedFacility(null);
        return;
      }
      setExpandedFacility(facility);
      const existing = peopleCache[facility];
      if (existing?.data || existing?.loading) return;

      const controller = new AbortController();
      peopleAbortRef.current = controller;
      setPeopleCache((prev) => ({ ...prev, [facility]: { loading: true, error: null, data: null } }));
      (async () => {
        try {
          const params = buildBaseParams();
          params.set("facility", facility);
          params.set("peoplePageSize", "25");
          params.set("peoplePage", "1");
          const res = await fetch(`/api/analytics/repeat-complainants/people?${params.toString()}`, { signal: controller.signal });
          const payload = await readJsonResponse(res);
          if (!res.ok) throw new Error(apiErrorMessage(payload, "تعذر تحميل قائمة الأشخاص."));
          if (!isRepeatComplainantPeopleData(payload)) throw new Error("استجابة قائمة الأشخاص غير مكتملة.");
          if (controller.signal.aborted) return;
          setPeopleCache((prev) => ({ ...prev, [facility]: { loading: false, error: null, data: payload } }));
        } catch (e) {
          if (isAbortError(e) || controller.signal.aborted) return;
          setPeopleCache((prev) => ({
            ...prev,
            [facility]: { loading: false, error: e instanceof Error ? e.message : "تعذر تحميل قائمة الأشخاص.", data: null },
          }));
        }
      })();
    },
    [expandedFacility, peopleCache, buildBaseParams]
  );

  const toggleRegion = useCallback((region: string) => {
    setExpandedRegions((prev) => {
      const next = new Set(prev);
      if (next.has(region)) next.delete(region);
      else next.add(region);
      return next;
    });
  }, []);

  /**
   * Shared by `openPersonDetail` and `changePersonSortOrder` — issues a
   * person-detail fetch under a NEW request generation + AbortController,
   * cancelling whatever was previously in flight. Because every caller bumps
   * `personRequestRef` before awaiting, and every response is only applied
   * when its own id STILL matches the ref, the most-recently-ISSUED request
   * always wins the render — regardless of which one's network response
   * actually arrives first (spec §5/§6: open A, then B before A resolves;
   * B's data must be what's shown even if A's response arrives last).
   */
  const fetchPersonDetail = useCallback(
    (token: string, facility: string | null, sortOrder: PersonDetailSortOrder) => {
      personAbortRef.current?.abort();
      const requestId = personRequestRef.current + 1;
      personRequestRef.current = requestId;
      const controller = new AbortController();
      personAbortRef.current = controller;
      (async () => {
        try {
          const params = buildBaseParams();
          params.set("token", token);
          if (facility) params.set("facility", facility);
          params.set("sortOrder", sortOrder);
          const res = await fetch(`/api/analytics/repeat-complainants/person?${params.toString()}`, { signal: controller.signal });
          const payload = await readJsonResponse(res);
          if (!res.ok) throw new Error(apiErrorMessage(payload, "تعذر تحميل تفاصيل الشخص."));
          if (!isRepeatComplainantPersonDetail(payload)) throw new Error("استجابة تفاصيل الشخص غير مكتملة.");
          // Either a newer person/sort-order request was issued meanwhile (id
          // mismatch), or this exact request was cancelled without a
          // replacement — e.g. the Sheet closed or the component unmounted
          // (signal aborted, id unchanged). Either way, this response is
          // stale and must never reach state.
          if (personRequestRef.current !== requestId || controller.signal.aborted) return;
          setPersonDetail({ loading: false, error: null, data: payload });
        } catch (e) {
          if (isAbortError(e) || personRequestRef.current !== requestId || controller.signal.aborted) return;
          setPersonDetail({ loading: false, error: e instanceof Error ? e.message : "تعذر تحميل تفاصيل الشخص.", data: null });
        }
      })();
    },
    [buildBaseParams]
  );

  const openPersonDetail = useCallback(
    (selection: SelectedPerson) => {
      setSelectedPerson(selection);
      setPersonSortOrder("desc");
      setPersonExportFull(false);
      setPersonDetail({ loading: true, error: null, data: null });
      fetchPersonDetail(selection.token, selection.facility, "desc");
    },
    [fetchPersonDetail]
  );

  const changePersonSortOrder = useCallback(
    (order: PersonDetailSortOrder) => {
      setPersonSortOrder(order);
      if (!selectedPerson) return;
      setPersonDetail((prev) => ({ ...prev, loading: true }));
      fetchPersonDetail(selectedPerson.token, selectedPerson.facility, order);
    },
    [selectedPerson, fetchPersonDetail]
  );

  const exportPersonPdf = useCallback(() => {
    if (!selectedPerson) return;
    setPersonExporting(true);
    const params = buildBaseParams();
    params.set("token", selectedPerson.token);
    if (selectedPerson.facility) params.set("facility", selectedPerson.facility);
    params.set("includeFullIdentifier", personExportFull ? "true" : "false");
    const url = `/api/analytics/repeat-complainants/person/export?${params.toString()}`;
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => setPersonExporting(false), 800);
  }, [selectedPerson, personExportFull, buildBaseParams]);

  const exportBulkPdf = useCallback(() => {
    setBulkExporting(true);
    const params = buildBaseParams();
    params.set("includeFullIdentifier", bulkExportFull ? "true" : "false");
    const url = `/api/analytics/repeat-complainants/export?${params.toString()}`;
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => setBulkExporting(false), 800);
  }, [bulkExportFull, buildBaseParams]);

  const sortedFacilities = useMemo(() => {
    const rows = summary?.facilities ?? [];
    return [...rows].sort((a, b) => b[sortKey] - a[sortKey]);
  }, [summary, sortKey]);

  const regionGroups = useMemo(() => {
    const byRegion = new Map<string, RepeatFacilitySummaryRow[]>();
    for (const row of sortedFacilities) {
      const list = byRegion.get(row.region) ?? [];
      list.push(row);
      byRegion.set(row.region, list);
    }
    return [...byRegion.entries()]
      .map(([region, facilities]) => ({
        region,
        facilities,
        totalPeople: facilities.reduce((sum, f) => sum + f.repeatedPeopleCount, 0),
      }))
      .sort((a, b) => b.totalPeople - a.totalPeople);
  }, [sortedFacilities]);

  const chartData = useMemo(
    () =>
      sortedFacilities.slice(0, 10).map((row) => ({
        facility: row.facility,
        عدد_الأشخاص_المكررين: row.repeatedPeopleCount,
      })),
    [sortedFacilities]
  );

  const sortedSearchResults = useMemo(() => {
    if (!searchResults) return null;
    return [...searchResults].sort(PEOPLE_SORT_COMPARATORS[peopleSortKey]);
  }, [searchResults, peopleSortKey]);

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
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">تكرار الشكاوى من نفس الشخص</h3>
          <p className="text-xs text-muted-foreground">
            تحليل الأشخاص الذين قدموا أكثر من شكوى، وأكثر السجون التي يظهر فيها هذا النمط.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="rc-bulk-full-id"
            checked={bulkExportFull}
            onCheckedChange={(checked) => setBulkExportFull(checked === true)}
          />
          <Label htmlFor="rc-bulk-full-id" className="text-xs font-normal">تضمين الهوية كاملة</Label>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={exportBulkPdf} disabled={bulkExporting}>
            <FileDown className="h-4 w-4" />
            {bulkExporting ? "جارٍ الإنشاء..." : "تصدير PDF للتحليل الكامل"}
          </Button>
        </div>
      </div>
      {bulkExportFull && (
        <p className="flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          يحتوي التقرير على بيانات شخصية تعريفية. يجب التعامل معه وفق ضوابط الوصول والمشاركة المعتمدة.
        </p>
      )}

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

      {/* Search */}
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative min-w-[240px] flex-1 space-y-1">
              <Label htmlFor="rc-search" className="text-xs">
                البحث بالاسم أو رقم الهوية أو المنطقة أو السجن أو نوع الشكوى
              </Label>
              <div className="relative">
                <Search className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="rc-search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="h-8 pr-8"
                  placeholder="اكتب للبحث..."
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => setSearchInput("")}
                    className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rc-people-sort" className="text-xs">ترتيب حسب</Label>
              <Select value={peopleSortKey} onValueChange={(v) => setPeopleSortKey(v as PeopleSortKey)}>
                <SelectTrigger id="rc-people-sort" className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PEOPLE_SORT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {searchQuery && (
            <div className="rounded-lg border">
              {searchLoading && <div className="p-4"><Skeleton className="h-20 w-full" /></div>}
              {searchError && <p className="p-4 text-sm text-destructive">{searchError}</p>}
              {sortedSearchResults && (
                <PeopleTable
                  people={sortedSearchResults}
                  onOpenDetail={openPersonDetail}
                  emptyMessage="لا توجد نتائج مطابقة."
                  scopeToFacility={false}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

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

      {/* Hierarchical region -> facility -> people browser */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">تصفح هرمي: المنطقة ← السجن ← الأشخاص</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 p-3">
          {regionGroups.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">لا يوجد تكرار شكاوى للفترة والفلاتر الحالية.</p>
          )}
          {regionGroups.map((group) => {
            const isRegionExpanded = expandedRegions.has(group.region);
            return (
              <div key={group.region} className="rounded-lg border">
                <button
                  type="button"
                  onClick={() => toggleRegion(group.region)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/40"
                >
                  <span className="flex items-center gap-1.5">
                    {isRegionExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                    {group.region}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatNumber(group.facilities.length)} سجن · {formatNumber(group.totalPeople)} شخص مكرر
                  </span>
                </button>
                {isRegionExpanded && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>السجن</TableHead>
                        <TableHead>الأشخاص المكررون</TableHead>
                        <TableHead>إجمالي الشكاوى</TableHead>
                        <TableHead>نسبة التكرار</TableHead>
                        <TableHead>أكثر نوع متكرر</TableHead>
                        <TableHead>الأولوية</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.facilities.map((row) => {
                        const isExpanded = expandedFacility === row.facility;
                        const peopleEntry = peopleCache[row.facility];
                        const sortedPeople = peopleEntry?.data
                          ? [...peopleEntry.data.people].sort(PEOPLE_SORT_COMPARATORS[peopleSortKey])
                          : null;
                        return (
                          <Fragment key={row.facility}>
                            <TableRow className="cursor-pointer hover:bg-muted/40" onClick={() => toggleFacility(row.facility)}>
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
                              <TableRow>
                                <TableCell colSpan={6} className="p-0">
                                  {peopleEntry?.loading && <div className="p-4"><Skeleton className="h-20 w-full" /></div>}
                                  {peopleEntry?.error && <p className="p-4 text-sm text-destructive">{peopleEntry.error}</p>}
                                  {sortedPeople && (
                                    <PeopleTable
                                      people={sortedPeople}
                                      onOpenDetail={openPersonDetail}
                                      emptyMessage="لا يوجد أشخاص مكررون ضمن الفلاتر الحالية."
                                      scopeToFacility
                                    />
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
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Person detail drawer */}
      <Sheet
        open={selectedPerson !== null}
        onOpenChange={(open) => {
          if (open) return;
          personAbortRef.current?.abort();
          setSelectedPerson(null);
        }}
      >
        <SheetContent side="left" className="w-full sm:max-w-lg md:max-w-xl lg:max-w-2xl p-0">
          <SheetHeader className="border-b bg-muted/30 px-5 pt-5 pb-3">
            <SheetTitle className="text-base">عرض التكرارات</SheetTitle>
            <SheetDescription className="sr-only">تفاصيل تكرار شكاوى شخص واحد</SheetDescription>
          </SheetHeader>
          <ScrollArea className="flex-1 min-h-0">
            {personDetail.loading && (
              <div className="space-y-3 p-5">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            )}
            {personDetail.error && <p className="p-5 text-sm text-destructive">{personDetail.error}</p>}
            {personDetail.data && (
              <PersonDetailContent
                detail={personDetail.data}
                selectedFacility={selectedPerson?.facility ?? null}
                sortOrder={personSortOrder}
                onSortOrderChange={changePersonSortOrder}
                includeFullIdentifier={personExportFull}
                onIncludeFullIdentifierChange={setPersonExportFull}
                onExport={exportPersonPdf}
                exporting={personExporting}
                onNavigateToExplorer={onNavigateToExplorer}
                from={from}
                to={to}
              />
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}
