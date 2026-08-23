"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowUpDown, ExternalLink, Flame, Radio, Sparkles, TrendingUp } from "lucide-react";
import { formatNumber } from "@/lib/ar-utils";
import type { RepeatFacilitySummaryRow } from "@/lib/analytics/repeat-complainant-directory";
// Types only — erased at compile time, no server runtime reaches the client bundle.
import type { RepeatPersonRowForClient } from "@/server/analytics/repeat-complainants/repeat-complainant-analytics-service";

/**
 * Small, presentation-only pieces shared across the repeat-complainants
 * panel and its extracted sub-components (view-mode selector, shared people
 * table, facility section) — kept together so none of those files need to
 * duplicate this markup/labels.
 */

export type SortOrder = "asc" | "desc";

export const PRIORITY_BAND_LABELS: Record<string, string> = { HIGH: "مرتفعة", MEDIUM: "متوسطة", LOW: "منخفضة" };
export const PRIORITY_BAND_CLASSES: Record<string, string> = {
  HIGH: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  MEDIUM: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  LOW: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export const PATTERN_LABELS: Record<string, string> = { CONCENTRATED: "تكرار مركز", DIVERSE: "تكرار متعدد الأنواع" };

/**
 * Analytical descriptions of the DATA, never a judgment about the person
 * (spec). Duplicated (not imported) from the PDF service's own
 * `patternDescription` on purpose — that module pulls in `node:crypto` +
 * PDFKit at runtime, which must never reach the client bundle.
 */
export function patternDescription(person: RepeatPersonRowForClient): string {
  const parts: string[] = [
    person.pattern === "CONCENTRATED" ? "تكرار مركز في تصنيف واحد بشكل رئيسي" : "تكرار متعدد الأنواع عبر عدة تصنيفات",
  ];
  if (person.spansMultiplePeriods) parts.push("مستمر عبر أكثر من فترة قياس");
  if (person.recentActivity) parts.push("نشاط حديث (معظم الشكاوى في آخر فترة)");
  return parts.join(" — ");
}

export function DrillButton({ onClick, label = "عرض الشكاوى" }: Readonly<{ onClick: () => void; label?: string }>) {
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

export function KpiCard({
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

export function FacilityBadges({ row }: Readonly<{ row: RepeatFacilitySummaryRow }>) {
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

export function PersonPatternBadges({ person }: Readonly<{ person: RepeatPersonRowForClient }>) {
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

export function SortOrderToggle({ order, onChange }: Readonly<{ order: SortOrder; onChange: (order: SortOrder) => void }>) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 gap-1 px-2 text-xs"
      onClick={() => onChange(order === "asc" ? "desc" : "asc")}
      title={order === "asc" ? "تصاعدي" : "تنازلي"}
    >
      <ArrowUpDown className="h-3.5 w-3.5" />
      {order === "asc" ? "تصاعدي" : "تنازلي"}
    </Button>
  );
}

export function PeoplePagination({
  page, pageSize, total, onPageChange,
}: Readonly<{ page: number; pageSize: number; total: number; onPageChange: (page: number) => void }>) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
      <span>صفحة {formatNumber(page)} من {formatNumber(pageCount)} · {formatNumber(total)} شخص</span>
      <div className="flex gap-1">
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          السابق
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>
          التالي
        </Button>
      </div>
    </div>
  );
}
