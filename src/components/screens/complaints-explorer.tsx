"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Search,
  Filter,
  Download,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Clock,
  AlertTriangle,
  RefreshCw,
  Star,
  X,
  FileText,
  MapPin,
  Building2,
  Tag,
  Calendar,
  Hash,
  CheckCircle2,
  Copy,
  MessageSquare,
  Sparkles,
  Activity,
} from "lucide-react";
import {
  formatNumber,
  formatDate,
  formatDateTime,
  PRIORITY_LABELS,
  SEVERITY_LABELS,
  statusBadgeClass,
  priorityBadgeClass,
} from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";

// ===================== Types =====================
interface Region {
  id: string;
  name: string;
}
interface Department {
  id: string;
  name: string;
}
interface ClassificationOption {
  id: string;
  name: string;
  color?: string;
  children?: { id: string; name: string; color?: string }[];
}
interface FiltersResponse {
  regions: Region[];
  departments: Department[];
  locations: { id: string; name: string }[];
  classifications: ClassificationOption[];
  channels: string[];
  sourceOrigins?: { id: string; name: string }[];
  sourceStatuses?: { id: string; name: string }[];
  sourceActionStatuses?: { id: string; name: string }[];
  wingCodes?: { id: string; name: string }[];
  dataFreshnessBuckets?: { id: string; name: string }[];
}

interface Complaint {
  id: string;
  externalId?: string | null;
  sourceReference?: string | null;
  complaintNumber: string;
  receivedDate: string;
  receivedAt?: string;
  channel: string | null;
  subject: string;
  description?: string;
  status: string;
  priority: string;
  severity: string;
  isRepeated?: boolean;
  isValidated?: boolean;
  isPotentialDuplicate?: boolean;
  beneficiarySatisfaction: number | null;
  delayReason: string | null;
  resolution: string | null;
  dueDate: string | null;
  closureDate: string | null;
  closedAt?: string | null;
  firstActionDate: string | null;
  referralDate: string | null;
  region: { name: string } | null;
  location: { name: string } | null;
  facility?: string | null;
  department: { name: string } | null;
  classification: { name: string; color: string } | null;
  isLate: boolean;
  isCurrentlyLate?: boolean;
  wasClosedLate?: boolean;
  latenessDays?: number | null;
  resolutionDays?: number | null;
  version?: number;
  updatedAt?: string;
  aiClassification?: string | null;
  aiConfidence?: number | null;
  aiReasoning?: string | null;
  aiSentiment?: string | null;
  aiSeverityScore?: number | null;
  aiSummary?: string | null;
  aiAnalyzedAt?: string | null;
}

interface ComplaintsResponse {
  items?: Complaint[];
  data?: Complaint[];
  pagination?: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
}

export interface FilterState {
  search: string;
  regionId: string;
  departmentId: string;
  facility: string;
  classificationId: string;
  channel: string;
  status: string;
  priority: string;
  severity: string;
  from: string;
  to: string;
  sourceOrigin: string;
  sourceStatus: string;
  sourceActionStatus: string;
  wingCode: string;
  dataFreshnessBucket: string;
  isLate: boolean;
  isRepeated: boolean;
  isValidated: boolean;
  aiAnalyzed: boolean;
}

// ===================== Constants =====================
const DEFAULT_FILTERS: FilterState = {
  search: "",
  regionId: "",
  departmentId: "",
  facility: "",
  classificationId: "",
  channel: "",
  status: "",
  priority: "",
  severity: "",
  from: "",
  to: "",
  sourceOrigin: "",
  sourceStatus: "",
  sourceActionStatus: "",
  wingCode: "",
  dataFreshnessBucket: "",
  isLate: false,
  isRepeated: false,
  isValidated: false,
  aiAnalyzed: false,
};

export const STATUS_OPTIONS = [
  { value: "NEW", label: "جديدة" },
  { value: "OPEN", label: "مفتوحة" },
  { value: "IN_PROGRESS", label: "قيد المعالجة" },
  { value: "AWAITING_RESPONSE", label: "بانتظار الرد" },
  { value: "RESOLVED", label: "تمت المعالجة" },
  { value: "CLOSED", label: "مغلقة" },
  { value: "CANCELLED", label: "ملغاة" },
] as const;

const STATUS_LABELS: Record<string, string> = {
  NEW: "جديدة",
  OPEN: "مفتوحة",
  IN_PROGRESS: "قيد المعالجة",
  AWAITING_RESPONSE: "بانتظار الرد",
  RESOLVED: "تمت المعالجة",
  CLOSED: "مغلقة",
  CANCELLED: "ملغاة",
};

const PRIORITY_OPTIONS = [
  { value: "low", label: "منخفضة" },
  { value: "medium", label: "متوسطة" },
  { value: "high", label: "عالية" },
  { value: "critical", label: "حرجة" },
];

const SEVERITY_OPTIONS = PRIORITY_OPTIONS;

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  medium: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  critical: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

function severityBadgeClass(severity: string): string {
  return SEVERITY_COLORS[severity] || SEVERITY_COLORS.medium;
}

const PAGE_SIZE = 10;

const SORT_FIELDS: { key: string; label: string }[] = [
  { key: "complaintNumber", label: "رقم الشكوى" },
  { key: "receivedDate", label: "التاريخ" },
  { key: "status", label: "الحالة" },
  { key: "priority", label: "الأولوية" },
  { key: "severity", label: "الخطورة" },
];

const STATUS_ALIASES: Record<string, string> = {
  NEW: "NEW",
  OPEN: "OPEN",
  IN_PROGRESS: "IN_PROGRESS",
  AWAITING_RESPONSE: "AWAITING_RESPONSE",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
  CANCELLED: "CANCELLED",
  REJECTED: "CANCELLED",
  REOPENED: "OPEN",
};

export function normalizeApiComplaintStatus(value: string): string {
  const normalized = value.trim().toUpperCase();

  if (!normalized) {
    return "";
  }

  return STATUS_ALIASES[normalized] ?? normalized;
}

function toLegacyPriorityValue(priority: string | null | undefined): string {
  return (priority ?? "medium").toLowerCase();
}

function normalizeComplaint(item: Complaint): Complaint {
  return {
    ...item,
    complaintNumber: item.complaintNumber ?? item.externalId ?? item.sourceReference ?? item.id,
    receivedDate: item.receivedDate ?? item.receivedAt ?? "",
    channel: item.channel ?? "",
    description: item.description ?? "",
    status: normalizeApiComplaintStatus(item.status),
    priority: toLegacyPriorityValue(item.priority),
    severity: toLegacyPriorityValue(item.severity),
    isRepeated: item.isRepeated ?? false,
    isValidated: item.isValidated ?? false,
    isPotentialDuplicate: item.isPotentialDuplicate ?? false,
    beneficiarySatisfaction: item.beneficiarySatisfaction ?? null,
    delayReason: item.delayReason ?? null,
    resolution: item.resolution ?? null,
    closureDate: item.closureDate ?? item.closedAt ?? null,
    firstActionDate: item.firstActionDate ?? null,
    referralDate: item.referralDate ?? null,
    location: item.location ?? (item.facility ? { name: item.facility } : null),
    isLate: item.isLate ?? item.isCurrentlyLate ?? item.wasClosedLate ?? false,
  };
}

function initialSearchParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

function initialFilterState(): FilterState {
  const params = initialSearchParams();
  return {
    ...DEFAULT_FILTERS,
    search: params.get("search") ?? "",
    regionId: params.get("regionId") ?? "",
    departmentId: params.get("departmentId") ?? "",
    facility: params.get("facility") ?? "",
    classificationId: params.get("classificationId") ?? "",
    channel: params.get("channel") ?? "",
    status: normalizeApiComplaintStatus(params.get("status") ?? ""),
    priority: params.get("priority") ?? "",
    severity: params.get("severity") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    sourceOrigin: params.get("sourceOrigin") ?? "",
    sourceStatus: params.get("sourceStatus") ?? "",
    sourceActionStatus: params.get("sourceActionStatus") ?? "",
    wingCode: params.get("wingCode") ?? "",
    dataFreshnessBucket: params.get("dataFreshnessBucket") ?? "",
    isLate: params.get("isLate") === "true",
    isRepeated: params.get("isRepeated") === "true",
    isValidated: params.get("isValidated") === "true",
    aiAnalyzed: params.get("aiAnalyzed") === "true",
  };
}

const SENTIMENT_LABELS: Record<string, string> = {
  positive: "إيجابي",
  neutral: "محايد",
  negative: "سلبي",
  very_negative: "سلبي جداً",
};

const SENTIMENT_COLORS: Record<string, string> = {
  positive: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  negative: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  very_negative: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function buildComplaintQuery(
  filters: FilterState,
  sortBy: string,
  sortOrder: "asc" | "desc",
  page?: number
): URLSearchParams {
  const params = new URLSearchParams();
  if (page !== undefined) params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));
  appendDefinedParams(params, {
    search: filters.search,
    regionId: filters.regionId,
    departmentId: filters.departmentId,
    facility: filters.facility,
    classificationId: filters.classificationId,
    channel: filters.channel,
    status: filters.status,
    priority: filters.priority,
    severity: filters.severity,
    from: filters.from,
    to: filters.to,
    sourceOrigin: filters.sourceOrigin,
    sourceStatus: filters.sourceStatus,
    sourceActionStatus: filters.sourceActionStatus,
    wingCode: filters.wingCode,
    dataFreshnessBucket: filters.dataFreshnessBucket,
  });
  appendFlagParams(params, {
    isLate: filters.isLate,
    isRepeated: filters.isRepeated,
    isValidated: filters.isValidated,
    aiAnalyzed: filters.aiAnalyzed,
  });
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);
  return params;
}

function appendDefinedParams(params: URLSearchParams, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
}

function appendFlagParams(params: URLSearchParams, flags: Record<string, boolean>): void {
  for (const [key, value] of Object.entries(flags)) {
    if (value) params.set(key, "true");
  }
}

export function extractFileName(disposition: string | null): string | null {
  if (!disposition) return null;
  const match = /filename="([^"]+)"/.exec(disposition);
  return match?.[1] ?? null;
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadComplaintExport(
  filters: FilterState,
  sortBy: string,
  sortOrder: "asc" | "desc"
): Promise<void> {
  const params = buildComplaintQuery(filters, sortBy, sortOrder);
  const response = await fetch(`/api/complaints/export?${params.toString()}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? "تعذر تصدير الشكاوى");
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition");
  const fileName = extractFileName(disposition) ?? `complaints-${formatLocalDate(new Date())}.csv`;
  triggerBlobDownload(blob, fileName);
}

// ===================== Sub-components =====================

function StarsRating({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <span className="text-xs text-muted-foreground">لا يوجد تقييم</span>
    );
  }
  return (
    <div className="flex items-center gap-0.5" dir="ltr">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`h-4 w-4 ${
            i <= value
              ? "fill-amber-400 text-amber-400"
              : "text-muted-foreground/30"
          }`}
        />
      ))}
      <span className="ml-2 text-xs text-muted-foreground">({value}/5)</span>
    </div>
  );
}

function SortHeader({
  label,
  field,
  sortBy,
  sortOrder,
  onToggle,
  align = "right",
}: {
  label: string;
  field: string;
  sortBy: string;
  sortOrder: "asc" | "desc";
  onToggle: (f: string) => void;
  align?: "right" | "center";
}) {
  const active = sortBy === field;
  return (
    <TableHead className={align === "center" ? "text-center" : "text-right"}>
      <button
        type="button"
        onClick={() => onToggle(field)}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        <span className="font-semibold">{label}</span>
        <span className="flex flex-col -space-y-1.5">
          <ChevronUp
            className={`h-3 w-3 ${
              active && sortOrder === "asc"
                ? "text-foreground"
                : "text-muted-foreground/40"
            }`}
          />
          <ChevronDown
            className={`h-3 w-3 ${
              active && sortOrder === "desc"
                ? "text-foreground"
                : "text-muted-foreground/40"
            }`}
          />
        </span>
      </button>
    </TableHead>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-medium break-words">
          {value ?? <span className="text-muted-foreground">—</span>}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
}: {
  icon: React.ElementType;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-2 mt-4 first:mt-0">
      <Icon className="h-4 w-4 text-primary" />
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
    </div>
  );
}

// ===================== Main Component =====================
export function countActiveFilters(filters: FilterState): number {
  const textKeys: Array<keyof FilterState> = [
    "search",
    "regionId",
    "departmentId",
    "facility",
    "classificationId",
    "channel",
    "status",
    "priority",
    "severity",
    "from",
    "to",
    "sourceOrigin",
    "sourceStatus",
    "sourceActionStatus",
    "wingCode",
    "dataFreshnessBucket",
  ];
  const flagKeys: Array<keyof FilterState> = ["isLate", "isRepeated", "isValidated"];
  return (
    textKeys.filter((key) => Boolean(filters[key])).length +
    flagKeys.filter((key) => filters[key] === true).length
  );
}

export function ComplaintsExplorer() {
  const [filters, setFilters] = useState<FilterState>(initialFilterState);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(initialFilterState);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [page, setPage] = useState(() => Number(initialSearchParams().get("page") ?? "1") || 1);
  const [sortBy, setSortBy] = useState(() => initialSearchParams().get("sortBy") ?? "receivedDate");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(() =>
    initialSearchParams().get("sortOrder") === "asc" ? "asc" : "desc"
  );
  const [data, setData] = useState<Complaint[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exportError, setExportError] = useState("");
  const [filterOptions, setFilterOptions] = useState<FiltersResponse | null>(
    null,
  );
  const [selected, setSelected] = useState<Complaint | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const filterRequestRef = useRef(0);
  const complaintsRequestRef = useRef(0);

  // Load filter options once on mount
  useEffect(() => {
    const controller = new AbortController();
    const requestId = filterRequestRef.current + 1;
    filterRequestRef.current = requestId;

    fetch("/api/filters", { signal: controller.signal })
      .then((r) => r.json())
      .then((json) => {
        if (!controller.signal.aborted && filterRequestRef.current === requestId) {
          setFilterOptions(json);
        }
      })
      .catch((e) => {
        if (!isAbortError(e)) {
          console.error("Failed to load filters:", e);
        }
      });
    return () => {
      controller.abort();
    };
  }, []);

  // Fetch complaints whenever applied filters / paging / sorting changes.
  useEffect(() => {
    const controller = new AbortController();
    const requestId = complaintsRequestRef.current + 1;
    complaintsRequestRef.current = requestId;
    const canUpdate = () =>
      !controller.signal.aborted && complaintsRequestRef.current === requestId;
    const params = buildComplaintQuery(appliedFilters, sortBy, sortOrder, page);

    const run = async () => {
      let aborted = false;
      try {
        setLoading(true);
        const res = await fetch(`/api/complaints?${params.toString()}`, {
          signal: controller.signal,
        });
        const json: ComplaintsResponse = await res.json();
        const items = json.items ?? json.data ?? [];
        const pagination = json.pagination;
        if (canUpdate()) {
          setData(items.map(normalizeComplaint));
          setTotal(pagination?.total ?? json.total ?? 0);
          setTotalPages(pagination?.totalPages ?? json.totalPages ?? 0);
        }
      } catch (e) {
        aborted = isAbortError(e);
        if (!aborted) {
          console.error("Failed to load complaints:", e);
        }
      } finally {
        if (!aborted && canUpdate()) {
          setLoading(false);
        }
      }
    };
    void run();
    return () => {
      controller.abort();
    };
  }, [appliedFilters, page, sortBy, sortOrder]);

  useEffect(() => {
    const params = buildComplaintQuery(appliedFilters, sortBy, sortOrder, page);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [appliedFilters, sortBy, sortOrder, page]);

  const activeFilterCount = useMemo(
    () => countActiveFilters(appliedFilters),
    [appliedFilters]
  );

  const applyFilters = useCallback(() => {
    setAppliedFilters(filters);
    setPage(1);
  }, [filters]);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setAppliedFilters(DEFAULT_FILTERS);
    setPage(1);
  }, []);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      applyFilters();
    }
  };

  const toggleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder("desc");
    }
    setPage(1);
  };

  const openDetail = (complaint: Complaint) => {
    setSelected(complaint);
    setSheetOpen(true);
  };

  const exportCSV = async () => {
    try {
      setExportError("");
      await downloadComplaintExport(appliedFilters, sortBy, sortOrder);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "تعذر تصدير الشكاوى");
    }
  };

  // Pagination range
  const pageNumbers = useMemo(() => {
    const range: (number | "...")[] = [];
    const maxVisible = 5;
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) range.push(i);
    } else {
      const start = Math.max(1, page - 2);
      const end = Math.min(totalPages, page + 2);
      if (start > 1) {
        range.push(1);
        if (start > 2) range.push("...");
      }
      for (let i = start; i <= end; i++) range.push(i);
      if (end < totalPages) {
        if (end < totalPages - 1) range.push("...");
        range.push(totalPages);
      }
    }
    return range;
  }, [page, totalPages]);

  const fromIndex = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toIndex = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="space-y-6">
      <PageHeader
        title="مستكشف الشكاوى"
        description="استعرض وفلتر وحلل جميع الشكاوى المسجلة في النظام"
        icon={<Search className="h-6 w-6" />}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFilters(appliedFilters);
                setShowAdvanced((v) => !v);
              }}
            >
              <Filter className="h-4 w-4" />
              فلاتر متقدمة
              {activeFilterCount > 0 && (
                <Badge
                  variant="secondary"
                  className="h-5 min-w-5 px-1.5 justify-center text-[10px]"
                >
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={exportCSV}
              disabled={data.length === 0}
            >
              <Download className="h-4 w-4" />
              تصدير CSV
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                setFilters(appliedFilters);
                applyFilters();
              }}
            >
              <RefreshCw className="h-4 w-4" />
              تحديث
            </Button>
          </>
        }
      />

      {/* Top filter bar */}
      <Card>
        <CardContent className="pt-0 space-y-4">
          <div className="flex flex-col lg:flex-row gap-3 lg:items-center">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="ابحث برقم الشكوى أو الموضوع أو الوصف..."
                value={filters.search}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, search: e.target.value }))
                }
                onKeyDown={onSearchKeyDown}
                className="pr-9"
              />
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <Select
                value={filters.status}
                onValueChange={(v) =>
                  setFilters((f) => ({ ...f, status: v === "all" ? "" : v }))
                }
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="الحالة" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الحالات</SelectItem>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={filters.priority}
                onValueChange={(v) =>
                  setFilters((f) => ({ ...f, priority: v === "all" ? "" : v }))
                }
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="الأولوية" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الأولويات</SelectItem>
                  {PRIORITY_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={filters.regionId}
                onValueChange={(v) =>
                  setFilters((f) => ({
                    ...f,
                    regionId: v === "all" ? "" : v,
                  }))
                }
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="المنطقة" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل المناطق</SelectItem>
                  {filterOptions?.regions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button onClick={applyFilters} size="default">
                <Search className="h-4 w-4" />
                بحث
              </Button>
              {activeFilterCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={resetFilters}
                  className="text-muted-foreground"
                >
                  <X className="h-4 w-4" />
                  مسح الفلاتر ({activeFilterCount})
                </Button>
              )}
            </div>
          </div>

          {/* Advanced filters */}
          {showAdvanced && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Filter className="h-4 w-4 text-primary" />
                  الفلاتر المتقدمة
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setShowAdvanced(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {/* Department */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    الإدارة
                  </Label>
                  <Select
                    value={filters.departmentId}
                    onValueChange={(v) =>
                      setFilters((f) => ({
                        ...f,
                        departmentId: v === "all" ? "" : v,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="كل الإدارات" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل الإدارات</SelectItem>
                      {filterOptions?.departments.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Facility */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    الموقع
                  </Label>
                  <Select
                    value={filters.facility}
                    onValueChange={(v) =>
                      setFilters((f) => ({
                        ...f,
                        facility: v === "all" ? "" : v,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="كل المواقع" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل المواقع</SelectItem>
                      {filterOptions?.locations.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Classification */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    التصنيف
                  </Label>
                  <Select
                    value={filters.classificationId}
                    onValueChange={(v) =>
                      setFilters((f) => ({
                        ...f,
                        classificationId: v === "all" ? "" : v,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="كل التصنيفات" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل التصنيفات</SelectItem>
                      {filterOptions?.classifications.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Channel */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    قناة الاستلام
                  </Label>
                  <Select
                    value={filters.channel}
                    onValueChange={(v) =>
                      setFilters((f) => ({
                        ...f,
                        channel: v === "all" ? "" : v,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="كل القنوات" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل القنوات</SelectItem>
                      {filterOptions?.channels.map((ch) => (
                        <SelectItem key={ch} value={ch}>
                          {ch}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">مصدر الورود</Label>
                  <Select
                    value={filters.sourceOrigin || "all"}
                    onValueChange={(v) =>
                      setFilters((f) => ({ ...f, sourceOrigin: v === "all" ? "" : v }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="كل المصادر" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل المصادر</SelectItem>
                      {(filterOptions?.sourceOrigins ?? []).map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>{opt.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">الحالة المصدرية</Label>
                  <Select
                    value={filters.sourceStatus || "all"}
                    onValueChange={(v) =>
                      setFilters((f) => ({ ...f, sourceStatus: v === "all" ? "" : v }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="كل الحالات المصدرية" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل الحالات المصدرية</SelectItem>
                      {(filterOptions?.sourceStatuses ?? []).map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>{opt.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">حالة الإجراء المصدرية</Label>
                  <Select
                    value={filters.sourceActionStatus || "all"}
                    onValueChange={(v) =>
                      setFilters((f) => ({ ...f, sourceActionStatus: v === "all" ? "" : v }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="كل حالات الإجراء" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل حالات الإجراء</SelectItem>
                      {(filterOptions?.sourceActionStatuses ?? []).map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>{opt.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">الجناح</Label>
                  <Select
                    value={filters.wingCode || "all"}
                    onValueChange={(v) =>
                      setFilters((f) => ({ ...f, wingCode: v === "all" ? "" : v }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="كل الأجنحة" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل الأجنحة</SelectItem>
                      {(filterOptions?.wingCodes ?? []).slice(0, 100).map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>{opt.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">حداثة البيانات</Label>
                  <Select
                    value={filters.dataFreshnessBucket || "all"}
                    onValueChange={(value) =>
                      setFilters((current) => ({
                        ...current,
                        dataFreshnessBucket: value === "all" ? "" : value,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="كل مستويات الحداثة" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل مستويات الحداثة</SelectItem>
                      {(filterOptions?.dataFreshnessBuckets ?? []).map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>
                          {opt.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Severity */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    الخطورة
                  </Label>
                  <Select
                    value={filters.severity}
                    onValueChange={(v) =>
                      setFilters((f) => ({
                        ...f,
                        severity: v === "all" ? "" : v,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="كل المستويات" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل المستويات</SelectItem>
                      {SEVERITY_OPTIONS.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* From date */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    من تاريخ
                  </Label>
                  <Input
                    type="date"
                    value={filters.from}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, from: e.target.value }))
                    }
                  />
                </div>

                {/* To date */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    إلى تاريخ
                  </Label>
                  <Input
                    type="date"
                    value={filters.to}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, to: e.target.value }))
                    }
                  />
                </div>
              </div>

              {/* Boolean toggles */}
              <div className="flex flex-wrap items-center gap-6 pt-2 border-t">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="filter-isLate"
                    checked={filters.isLate}
                    onCheckedChange={(v) =>
                      setFilters((f) => ({ ...f, isLate: v === true }))
                    }
                  />
                  <Label
                    htmlFor="filter-isLate"
                    className="text-sm cursor-pointer flex items-center gap-1.5"
                  >
                    <Clock className="h-3.5 w-3.5 text-red-500" />
                    الشكاوى المتأخرة فقط
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="filter-isRepeated"
                    checked={filters.isRepeated}
                    onCheckedChange={(v) =>
                      setFilters((f) => ({ ...f, isRepeated: v === true }))
                    }
                  />
                  <Label
                    htmlFor="filter-isRepeated"
                    className="text-sm cursor-pointer flex items-center gap-1.5"
                  >
                    <Copy className="h-3.5 w-3.5 text-amber-500" />
                    الشكاوى المتكررة فقط
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="filter-isValidated"
                    checked={filters.isValidated}
                    onCheckedChange={(v) =>
                      setFilters((f) => ({ ...f, isValidated: v === true }))
                    }
                  />
                  <Label
                    htmlFor="filter-isValidated"
                    className="text-sm cursor-pointer flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    الشكاوى المعتمدة فقط
                  </Label>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  <RefreshCw className="h-4 w-4" />
                  إعادة تعيين
                </Button>
                <Button size="sm" onClick={applyFilters}>
                  <Search className="h-4 w-4" />
                  تطبيق الفلاتر
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Results summary */}
      {exportError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {exportError}
        </div>
      )}

      {/* Results summary */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" className="text-sm px-3 py-1">
            <FileText className="h-3.5 w-3.5 ml-1" />
            {loading ? (
              <Skeleton className="h-4 w-12 inline-block" />
            ) : (
              <span className="font-semibold">{formatNumber(total)}</span>
            )}
            <span className="text-muted-foreground mr-1">شكوى</span>
          </Badge>
          {activeFilterCount > 0 && (
            <Badge
              variant="outline"
              className="text-sm px-3 py-1 border-primary/30 text-primary"
            >
              <Filter className="h-3.5 w-3.5 ml-1" />
              {activeFilterCount} فلتر نشط
            </Badge>
          )}
          {!loading && total > 0 && (
            <span className="text-xs text-muted-foreground">
              عرض {formatNumber(fromIndex)} - {formatNumber(toIndex)} من{" "}
              {formatNumber(total)}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <span>ترتيب حسب:</span>
          <Select
            value={sortBy}
            onValueChange={(v) => {
              setSortBy(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_FIELDS.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() =>
              setSortOrder((p) => (p === "asc" ? "desc" : "asc"))
            }
          >
            {sortOrder === "asc" ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Data table */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <SortHeader
                    label="رقم الشكوى"
                    field="complaintNumber"
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onToggle={toggleSort}
                  />
                  <SortHeader
                    label="التاريخ"
                    field="receivedDate"
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onToggle={toggleSort}
                  />
                  <TableHead className="text-right font-semibold">
                    الموضوع
                  </TableHead>
                  <SortHeader
                    label="الحالة"
                    field="status"
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onToggle={toggleSort}
                  />
                  <SortHeader
                    label="الأولوية"
                    field="priority"
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onToggle={toggleSort}
                  />
                  <SortHeader
                    label="الخطورة"
                    field="severity"
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onToggle={toggleSort}
                  />
                  <TableHead className="text-right font-semibold">
                    المنطقة
                  </TableHead>
                  <TableHead className="text-right font-semibold">
                    الإدارة
                  </TableHead>
                  <TableHead className="text-right font-semibold">
                    التصنيف
                  </TableHead>
                  <TableHead className="text-center font-semibold">
                    مؤشرات
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={`sk-${i}`}>
                      <TableCell>
                        <Skeleton className="h-4 w-20" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-40" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-16 rounded-full" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-14 rounded-full" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-14 rounded-full" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-20" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-20 rounded-full" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-10" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="h-48">
                      <div className="flex flex-col items-center justify-center text-center gap-3 py-8">
                        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                          <FileText className="h-7 w-7 text-muted-foreground" />
                        </div>
                        <div>
                          <p className="font-semibold text-foreground">
                            لا توجد شكاوى مطابقة
                          </p>
                          <p className="text-sm text-muted-foreground mt-1">
                            جرّب تعديل معايير البحث أو إعادة تعيين الفلاتر
                          </p>
                        </div>
                        {activeFilterCount > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={resetFilters}
                            className="mt-2"
                          >
                            <RefreshCw className="h-4 w-4" />
                            مسح جميع الفلاتر
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  data.map((c) => (
                    <TableRow
                      key={c.id}
                      onClick={() => openDetail(c)}
                      className="cursor-pointer"
                    >
                      <TableCell className="font-mono text-xs font-medium text-primary">
                        {c.complaintNumber}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDate(c.receivedDate)}
                      </TableCell>
                      <TableCell className="max-w-[280px]">
                        <div className="truncate text-sm" title={c.subject}>
                          {c.subject}
                        </div>
                        <div
                          className="truncate text-xs text-muted-foreground mt-0.5"
                          title={c.description}
                        >
                          {c.description}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={`text-[11px] ${statusBadgeClass(c.status)}`}
                        >
                          {STATUS_LABELS[c.status] || c.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={`text-[11px] ${priorityBadgeClass(c.priority)}`}
                        >
                          {PRIORITY_LABELS[c.priority] || c.priority}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={`text-[11px] ${severityBadgeClass(c.severity)}`}
                        >
                          {SEVERITY_LABELS[c.severity] || c.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.region?.name || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.department?.name || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {c.classification ? (
                          <Badge
                            variant="outline"
                            className="text-[11px] gap-1"
                            style={{
                              borderColor: c.classification.color
                                ? `${c.classification.color}66`
                                : undefined,
                              backgroundColor: c.classification.color
                                ? `${c.classification.color}14`
                                : undefined,
                              color: c.classification.color || undefined,
                            }}
                          >
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{
                                backgroundColor:
                                  c.classification.color || "#64748b",
                              }}
                            />
                            {c.classification.name}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-center gap-1">
                          {c.isLate && (
                            <span
                              title="شكوى متأخرة"
                              className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-300"
                            >
                              <Clock className="h-3.5 w-3.5" />
                            </span>
                          )}
                          {c.isPotentialDuplicate && (
                            <span
                              title="تكرار محتمل"
                              className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300"
                            >
                              <AlertTriangle className="h-3.5 w-3.5" />
                            </span>
                          )}
                          {c.isRepeated && (
                            <span
                              title="شكوى متكررة"
                              className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-300"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </span>
                          )}
                          {c.isValidated && (
                            <span
                              title="معتمدة"
                              className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            </span>
                          )}
                          {!c.isLate &&
                            !c.isPotentialDuplicate &&
                            !c.isRepeated &&
                            !c.isValidated && (
                              <span className="text-muted-foreground/40 text-xs">
                                —
                              </span>
                            )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Pagination */}
      {!loading && total > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground order-2 sm:order-1">
            الصفحة {formatNumber(page)} من {formatNumber(totalPages || 1)}
          </div>
          <div className="flex items-center gap-1 order-1 sm:order-2 flex-wrap justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(1)}
              disabled={page <= 1}
              className="gap-1"
            >
              <ChevronRight className="h-4 w-4" />
              <ChevronRight className="h-3 w-3 -mr-2" />
              الأولى
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            {pageNumbers.map((p, idx) =>
              p === "..." ? (
                <span
                  key={`ellipsis-${idx}`}
                  className="px-2 text-muted-foreground"
                >
                  …
                </span>
              ) : (
                <Button
                  key={`page-${p}`}
                  variant={p === page ? "default" : "outline"}
                  size="icon"
                  className="h-8 w-8 text-xs"
                  onClick={() => setPage(p)}
                >
                  {formatNumber(p)}
                </Button>
              ),
            )}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(totalPages)}
              disabled={page >= totalPages}
              className="gap-1"
            >
              الأخيرة
              <ChevronLeft className="h-3 w-3 -ml-1" />
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Detail Drawer */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="left"
          className="w-full sm:max-w-lg md:max-w-xl lg:max-w-2xl p-0"
        >
          <SheetHeader className="border-b bg-muted/30 px-5 pt-5 pb-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Hash className="h-3.5 w-3.5" />
              <span className="font-mono">{selected?.complaintNumber}</span>
            </div>
            <SheetTitle className="text-lg leading-snug pr-6">
              {selected?.subject}
            </SheetTitle>
            <SheetDescription className="sr-only">
              تفاصيل الشكوى
            </SheetDescription>
            {selected && (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <Badge
                  variant="secondary"
                  className={`text-[11px] ${statusBadgeClass(selected.status)}`}
                >
                  {STATUS_LABELS[selected.status] || selected.status}
                </Badge>
                <Badge
                  variant="secondary"
                  className={`text-[11px] ${priorityBadgeClass(selected.priority)}`}
                >
                  أولوية {PRIORITY_LABELS[selected.priority] || selected.priority}
                </Badge>
                <Badge
                  variant="secondary"
                  className={`text-[11px] ${severityBadgeClass(selected.severity)}`}
                >
                  خطورة {SEVERITY_LABELS[selected.severity] || selected.severity}
                </Badge>
                {selected.isLate && (
                  <Badge
                    variant="secondary"
                    className="text-[11px] bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 gap-1"
                  >
                    <Clock className="h-3 w-3" />
                    متأخرة
                  </Badge>
                )}
                {selected.isPotentialDuplicate && (
                  <Badge
                    variant="secondary"
                    className="text-[11px] bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 gap-1"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    تكرار محتمل
                  </Badge>
                )}
                {selected.isRepeated && (
                  <Badge
                    variant="secondary"
                    className="text-[11px] bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 gap-1"
                  >
                    <Copy className="h-3 w-3" />
                    متكررة
                  </Badge>
                )}
                {selected.isValidated && (
                  <Badge
                    variant="secondary"
                    className="text-[11px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 gap-1"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    معتمدة
                  </Badge>
                )}
              </div>
            )}
          </SheetHeader>

          {selected && (
            <ScrollArea className="flex-1">
              <div className="px-5 py-4 space-y-1">
                {/* Description */}
                <SectionTitle
                  icon={MessageSquare}
                  title="موضوع الشكوى"
                />
                <div className="rounded-lg border bg-muted/20 p-3 text-sm leading-relaxed">
                  {selected.description}
                </div>

                {/* Entities */}
                <SectionTitle icon={Building2} title="التصنيف والكيانات" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                  <InfoRow
                    icon={MapPin}
                    label="المنطقة"
                    value={selected.region?.name}
                  />
                  <InfoRow
                    icon={MapPin}
                    label="الموقع"
                    value={selected.location?.name}
                  />
                  <InfoRow
                    icon={Building2}
                    label="الإدارة"
                    value={selected.department?.name}
                  />
                  <InfoRow
                    icon={Tag}
                    label="التصنيف"
                    value={
                      selected.classification ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{
                              backgroundColor:
                                selected.classification.color || "#64748b",
                            }}
                          />
                          {selected.classification.name}
                        </span>
                      ) : null
                    }
                  />
                  <InfoRow
                    icon={Activity}
                    label="قناة الاستلام"
                    value={selected.channel}
                  />
                </div>

                <Separator className="my-3" />

                {/* Dates */}
                <SectionTitle icon={Calendar} title="التواريخ المهمة" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                  <InfoRow
                    icon={Calendar}
                    label="تاريخ الاستلام"
                    value={formatDateTime(selected.receivedDate)}
                  />
                  <InfoRow
                    icon={Calendar}
                    label="تاريخ الإحالة"
                    value={
                      selected.referralDate
                        ? formatDateTime(selected.referralDate)
                        : null
                    }
                  />
                  <InfoRow
                    icon={Calendar}
                    label="تاريخ أول إجراء"
                    value={
                      selected.firstActionDate
                        ? formatDateTime(selected.firstActionDate)
                        : null
                    }
                  />
                  <InfoRow
                    icon={Calendar}
                    label="تاريخ الاستحقاق"
                    value={
                      selected.dueDate ? formatDate(selected.dueDate) : null
                    }
                  />
                  <InfoRow
                    icon={CheckCircle2}
                    label="تاريخ الإغلاق"
                    value={
                      selected.closureDate
                        ? formatDateTime(selected.closureDate)
                        : null
                    }
                  />
                </div>

                {/* Resolution & delay */}
                {(selected.resolution || selected.delayReason) && (
                  <>
                    <Separator className="my-3" />
                    <SectionTitle
                      icon={FileText}
                      title="الحل وسبب التأخير"
                    />
                    {selected.resolution && (
                      <div className="rounded-lg border bg-emerald-50/50 dark:bg-emerald-900/10 p-3 mb-2">
                        <div className="text-xs text-muted-foreground mb-1">
                          القرار / الحل
                        </div>
                        <div className="text-sm leading-relaxed">
                          {selected.resolution}
                        </div>
                      </div>
                    )}
                    {selected.delayReason && (
                      <div className="rounded-lg border bg-red-50/50 dark:bg-red-900/10 p-3">
                        <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          سبب التأخير
                        </div>
                        <div className="text-sm leading-relaxed">
                          {selected.delayReason}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Satisfaction */}
                {selected.beneficiarySatisfaction != null && (
                  <>
                    <Separator className="my-3" />
                    <SectionTitle icon={Star} title="رضا المستفيد" />
                    <div className="rounded-lg border bg-amber-50/50 dark:bg-amber-900/10 p-3">
                      <StarsRating value={selected.beneficiarySatisfaction} />
                    </div>
                  </>
                )}

                {/* AI Analysis */}
                {selected.aiAnalyzedAt && (
                  <>
                    <Separator className="my-3" />
                    <SectionTitle icon={Sparkles} title="التحليل الذكي" />
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-3">
                      {selected.aiSummary && (
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">
                            الملخص
                          </div>
                          <div className="text-sm leading-relaxed">
                            {selected.aiSummary}
                          </div>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        {selected.aiClassification && (
                          <div>
                            <div className="text-xs text-muted-foreground">
                              التصنيف المقترح
                            </div>
                            <div className="text-sm font-medium">
                              {selected.aiClassification}
                            </div>
                          </div>
                        )}
                        {selected.aiConfidence != null && (
                          <div>
                            <div className="text-xs text-muted-foreground">
                              نسبة الثقة
                            </div>
                            <div className="text-sm font-medium">
                              {Math.round(selected.aiConfidence * 100)}%
                            </div>
                          </div>
                        )}
                        {selected.aiSentiment && (
                          <div>
                            <div className="text-xs text-muted-foreground">
                              المشاعر
                            </div>
                            <Badge
                              variant="secondary"
                              className={`text-[11px] mt-0.5 ${
                                SENTIMENT_COLORS[selected.aiSentiment] || ""
                              }`}
                            >
                              {SENTIMENT_LABELS[selected.aiSentiment] ||
                                selected.aiSentiment}
                            </Badge>
                          </div>
                        )}
                        {selected.aiSeverityScore != null && (
                          <div>
                            <div className="text-xs text-muted-foreground">
                              درجة الخطورة
                            </div>
                            <div className="text-sm font-medium">
                              {selected.aiSeverityScore.toFixed(2)} / 1.0
                            </div>
                          </div>
                        )}
                      </div>
                      {selected.aiReasoning && (
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">
                            التبرير
                          </div>
                          <div className="text-xs leading-relaxed text-muted-foreground">
                            {selected.aiReasoning}
                          </div>
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground pt-1 border-t">
                        حُلِّل في:{" "}
                        {formatDateTime(selected.aiAnalyzedAt)}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </ScrollArea>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
