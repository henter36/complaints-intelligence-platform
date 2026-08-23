"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { Eye, EyeOff } from "lucide-react";
import { formatNumber } from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";
import { isRecord, readJsonResponse } from "@/lib/analytics/analytics-api-contract";
// Types only — erased at compile time, no server runtime reaches the client bundle.
import type { RepeatPersonRowForClient } from "@/server/analytics/repeat-complainants/repeat-complainant-analytics-service";

/** `facility: null` means "org-wide" — every complaint of this person across every facility they appear at, not just the one their row was opened from. */
export type SelectedPerson = { token: string; facility: string | null };

/**
 * "organization" = the org-wide identity view (unified list, search
 * results, and the pre-existing region→facility browser's per-facility
 * list) — shows region/facility columns, since a row's facility isn't
 * implied by context. "facility" = the flat "حسب السجن" view's own list —
 * every row already belongs to one known facility, so those columns are
 * dropped in favor of facility-scoped repeat metrics instead (repeatCount,
 * highest same-type repeat, "ظهر في N سجون" badge).
 */
export type PeopleTableScope = "organization" | "facility";

/** Both scopes render exactly 9 columns — see RepeatPersonTableRow. */
const REPEAT_PEOPLE_TABLE_COLUMN_COUNT = 9;

/**
 * Shows the masked identifier by default; the raw value is fetched ONLY on
 * an explicit click (never preloaded, never cached beyond this component's
 * own state, never written to the URL — spec's reveal-toggle requirement).
 */
export function IdentityCell({ person }: Readonly<{ person: RepeatPersonRowForClient }>) {
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

function RepeatPersonTableRow({
  person, scope, onOpenDetail, scopeDetailToFacility,
}: Readonly<{
  person: RepeatPersonRowForClient;
  scope: PeopleTableScope;
  onOpenDetail: (selection: SelectedPerson) => void;
  /**
   * Only meaningful when scope === "organization" — true inside a
   * facility-expanded list where every row genuinely belongs to just that
   * facility (e.g. the region→facility browser), so opening detail should
   * still be facility-scoped even though org-style columns are shown;
   * false for genuinely org-wide contexts (unified list, search results).
   * scope === "facility" rows are ALWAYS facility-scoped by definition,
   * regardless of this flag.
   */
  scopeDetailToFacility: boolean;
}>) {
  const topType = person.topComplaintTypes[0];
  const isFacilityScope = scope === "facility";
  const detailFacility = isFacilityScope || scopeDetailToFacility ? person.facility : null;
  const repeatCount = Math.max(0, person.totalComplaints - 1);
  return (
    <TableRow>
      <TableCell className="font-medium">
        {isFacilityScope ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {person.complainantName ?? "غير متوفر"}
            {person.orgFacilitiesCount !== undefined && person.orgFacilitiesCount > 1 && (
              <Badge variant="outline" className="text-[10px]">ظهر في {formatNumber(person.orgFacilitiesCount)} سجون</Badge>
            )}
          </div>
        ) : (
          person.complainantName ?? "غير متوفر"
        )}
      </TableCell>
      <TableCell><IdentityCell person={person} /></TableCell>
      {scope === "organization" && (
        <>
          <TableCell className="text-muted-foreground">{person.region}</TableCell>
          <TableCell className="max-w-[160px] truncate">
            {person.facilitiesCount > 1 ? `${person.facility} (+${formatNumber(person.facilitiesCount - 1)})` : person.facility}
          </TableCell>
        </>
      )}
      <TableCell>{formatNumber(person.totalComplaints)}</TableCell>
      {isFacilityScope && <TableCell>{formatNumber(repeatCount)}</TableCell>}
      <TableCell>{formatNumber(person.distinctComplaintTypesCount)}</TableCell>
      <TableCell className="max-w-[140px] truncate">{topType ? `${topType.label} (${formatNumber(topType.count)})` : "—"}</TableCell>
      {isFacilityScope && <TableCell>{formatNumber(person.sameTypeRepeatCount)}</TableCell>}
      <TableCell className="text-muted-foreground">{person.lastComplaintDate}</TableCell>
      <TableCell>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onOpenDetail({ token: person.complainantToken, facility: detailFacility })}
        >
          عرض التكرارات
        </Button>
      </TableCell>
    </TableRow>
  );
}

/**
 * The single, reusable person-list table for every repeat-complainants view
 * (unified list, search results, the region→facility browser's per-facility
 * list, and the flat "حسب السجن" view) — replaces what used to be two
 * near-identical table components (`PeopleTable`/`FacilityPeopleTable`).
 * `scope` picks the column set (spec §3/§6); `scopeDetailToFacility` picks
 * the drill-through facility-scoping for the "organization" column set (see
 * `RepeatPersonTableRow`'s own docstring) — "facility" scope is always
 * facility-scoped regardless of this flag.
 */
export function RepeatPeopleTable({
  people, scope, onOpenDetail, emptyMessage, scopeDetailToFacility = false,
}: Readonly<{
  people: RepeatPersonRowForClient[];
  scope: PeopleTableScope;
  onOpenDetail: (selection: SelectedPerson) => void;
  emptyMessage: string;
  scopeDetailToFacility?: boolean;
}>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>الاسم</TableHead>
          <TableHead>الهوية</TableHead>
          {scope === "organization" && (
            <>
              <TableHead>المنطقة</TableHead>
              <TableHead>السجن</TableHead>
            </>
          )}
          <TableHead>عدد الشكاوى</TableHead>
          {scope === "facility" && <TableHead>عدد التكرارات</TableHead>}
          <TableHead>{scope === "organization" ? "أنواع الشكاوى" : "عدد الأنواع"}</TableHead>
          <TableHead>الأكثر تكراراً</TableHead>
          {scope === "facility" && <TableHead>أعلى تكرار لنفس النوع</TableHead>}
          <TableHead>آخر شكوى</TableHead>
          <TableHead>التفاصيل</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {people.length === 0 && (
          <TableRow>
            <TableCell colSpan={REPEAT_PEOPLE_TABLE_COLUMN_COUNT} className="text-center text-sm text-muted-foreground py-8">
              {emptyMessage}
            </TableCell>
          </TableRow>
        )}
        {people.map((person) => (
          <RepeatPersonTableRow
            key={person.complainantToken}
            person={person}
            scope={scope}
            onOpenDetail={onOpenDetail}
            scopeDetailToFacility={scopeDetailToFacility}
          />
        ))}
      </TableBody>
    </Table>
  );
}
