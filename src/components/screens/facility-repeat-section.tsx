"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  AccordionItem, AccordionTrigger, AccordionContent,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/ar-utils";
import { buildRepeatComplainantDrilldownQuery } from "@/lib/analytics/repeat-complainant-api-contract";
import type { RepeatFacilitySummaryRow } from "@/lib/analytics/repeat-complainant-directory";
import {
  DrillButton, FacilityBadges, PRIORITY_BAND_CLASSES, PRIORITY_BAND_LABELS,
  SortOrderToggle, PeoplePagination, type SortOrder,
} from "@/components/screens/repeat-complainant-shared";
import { RepeatPeopleTable, type SelectedPerson } from "@/components/screens/repeat-people-table";
import {
  PEOPLE_LIST_SORT_OPTIONS, type FlatPeopleState, type PeopleListSortKey,
} from "@/hooks/use-repeat-complainant-people-views";

/**
 * One facility's independent, collapsible section within the flat "حسب
 * السجن" view — a pure presentation component (header stats + this
 * facility's own lazily-loaded people list); all fetch/state orchestration
 * lives in `useRepeatComplainantPeopleViews` and the parent panel, passed
 * in as data + callbacks here.
 */
export function FacilityRepeatSection({
  row, facilityIndex, peopleEntry, onToggle, onPeopleSortKeyChange, onPeopleSortOrderChange, onPeoplePageChange,
  onOpenDetail, onNavigateToExplorer, from, to,
}: Readonly<{
  row: RepeatFacilitySummaryRow;
  /** Used only to build a unique id for the per-facility sort-select's aria-labelledby — never interpolate the raw facility name into an id (it contains spaces, which breaks aria-labelledby's space-separated-token-list resolution). */
  facilityIndex: number;
  peopleEntry: FlatPeopleState | undefined;
  onToggle: () => void;
  onPeopleSortKeyChange: (key: PeopleListSortKey) => void;
  onPeopleSortOrderChange: (order: SortOrder) => void;
  onPeoplePageChange: (page: number) => void;
  onOpenDetail: (selection: SelectedPerson) => void;
  onNavigateToExplorer?: (query: Record<string, string>) => void;
  from: string;
  to: string;
}>) {
  const sortLabelId = `rc-flat-people-sort-label-${facilityIndex}`;
  return (
    <AccordionItem value={row.facility} className="rounded-lg border px-3">
      <AccordionTrigger onClick={onToggle} className="py-2.5 text-sm hover:no-underline">
        <div className="flex w-full flex-wrap items-center justify-between gap-2 pl-2 text-right">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 font-medium">
              {row.facility}
              <span className="text-xs font-normal text-muted-foreground">({row.region})</span>
              <Badge className={PRIORITY_BAND_CLASSES[row.priorityBand]}>
                {PRIORITY_BAND_LABELS[row.priorityBand] ?? row.priorityBand}
              </Badge>
            </div>
            <FacilityBadges row={row} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>أشخاص مكررون: <strong className="text-foreground">{formatNumber(row.repeatedPeopleCount)}</strong></span>
            <span>إجمالي شكاواهم: <strong className="text-foreground">{formatNumber(row.repeatedComplaintsCount)}</strong></span>
            <span>أعلى تكرار لشخص: <strong className="text-foreground">{formatNumber(row.highestRepeatByOnePerson)}</strong></span>
            <span>
              أكثر نوع متكرر:{" "}
              <strong className="text-foreground">
                {row.topComplaintType ? `${row.topComplaintType.label} (${formatNumber(row.topComplaintType.count)})` : "—"}
              </strong>
            </span>
            {onNavigateToExplorer && (
              <DrillButton
                onClick={() => onNavigateToExplorer(buildRepeatComplainantDrilldownQuery(row.drilldownFilters, { from, to }))}
              />
            )}
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent>
        {peopleEntry?.loading && <div className="p-4"><Skeleton className="h-20 w-full" /></div>}
        {peopleEntry?.error && <p className="p-4 text-sm text-destructive">{peopleEntry.error}</p>}
        {peopleEntry?.data && !peopleEntry.loading && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label id={sortLabelId} className="text-xs">ترتيب الأشخاص حسب</Label>
                <Select value={peopleEntry.sortKey} onValueChange={(v) => onPeopleSortKeyChange(v as PeopleListSortKey)}>
                  <SelectTrigger aria-labelledby={sortLabelId} className="h-8 w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PEOPLE_LIST_SORT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <SortOrderToggle order={peopleEntry.sortOrder} onChange={onPeopleSortOrderChange} />
            </div>
            <RepeatPeopleTable
              people={peopleEntry.data.people}
              scope="facility"
              onOpenDetail={onOpenDetail}
              emptyMessage="لا يوجد أشخاص مكررون ضمن الفلاتر الحالية."
            />
            <PeoplePagination
              page={peopleEntry.page}
              pageSize={peopleEntry.data.pageSize}
              total={peopleEntry.data.total}
              onPageChange={onPeoplePageChange}
            />
          </div>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}
