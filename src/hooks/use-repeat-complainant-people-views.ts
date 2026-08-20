import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "@/lib/abort";
import { readJsonResponse, apiErrorMessage } from "@/lib/analytics/analytics-api-contract";
import {
  isRepeatComplainantPeopleData,
  type RepeatComplainantPeopleData,
} from "@/lib/analytics/repeat-complainant-api-contract";
import type { ViewMode } from "@/components/screens/repeat-complainant-view-mode-selector";
import type { SortOrder } from "@/components/screens/repeat-complainant-shared";

/** Person sort keys shared by the flat "حسب السجن" and "قائمة موحدة" views — mirrors the server's own PeopleSortKey (repeat-complainant-people-service.ts) since sorting/pagination happen server-side for these two views. */
export type PeopleListSortKey = "totalComplaints" | "repeatCount" | "lastComplaintDate" | "distinctComplaintTypesCount" | "sameTypeRepeatCount" | "name";

export const PEOPLE_LIST_SORT_OPTIONS: { key: PeopleListSortKey; label: string }[] = [
  { key: "totalComplaints", label: "عدد الشكاوى" },
  { key: "repeatCount", label: "عدد التكرارات" },
  { key: "distinctComplaintTypesCount", label: "عدد الأنواع" },
  { key: "sameTypeRepeatCount", label: "أعلى تكرار لنفس النوع" },
  { key: "lastComplaintDate", label: "آخر شكوى" },
  { key: "name", label: "الاسم" },
];

const PEOPLE_LIST_PAGE_SIZE = 25;

/** Per-facility cache entry for the flat "حسب السجن" view — carries its OWN page/sort so several facilities can each be paged/sorted independently. */
export type FlatPeopleState = {
  loading: boolean;
  error: string | null;
  data: RepeatComplainantPeopleData | null;
  page: number;
  sortKey: PeopleListSortKey;
  sortOrder: SortOrder;
};

export type UnifiedPeopleState = {
  loading: boolean;
  error: string | null;
  data: RepeatComplainantPeopleData | null;
  page: number;
  sortKey: PeopleListSortKey;
  sortOrder: SortOrder;
};

const INITIAL_UNIFIED_STATE: UnifiedPeopleState = {
  loading: false, error: null, data: null, page: 1, sortKey: "totalComplaints", sortOrder: "desc",
};

/**
 * Fetch/state orchestration for the two NEW repeat-complainants views added
 * alongside the pre-existing region→facility browser: the flat "حسب السجن"
 * view (independent, lazily-loaded, independently paginated/sorted
 * per-facility people lists) and the "قائمة موحدة" org-wide list. Reuses
 * the SAME `getRepeatComplainantPeoplePage` endpoint as the pre-existing
 * view (via `buildBaseParams`) — never a second engine/endpoint.
 *
 * Deliberately does NOT own the pre-existing region→facility browser's own
 * state (`expandedFacility`/`peopleCache`/etc.) — that view's behavior must
 * stay byte-for-byte unchanged, so it stays where it already lived.
 */
export function useRepeatComplainantPeopleViews({
  viewMode, buildBaseParams,
}: Readonly<{ viewMode: ViewMode; buildBaseParams: () => URLSearchParams }>) {
  const [flatExpanded, setFlatExpanded] = useState<Set<string>>(new Set());
  const [flatPeople, setFlatPeople] = useState<Record<string, FlatPeopleState>>({});
  /** One AbortController per expanded facility — unlike the single-facility region view, several can legitimately be in flight at once here. */
  const flatAbortRefs = useRef<Map<string, AbortController>>(new Map());

  const [unifiedState, setUnifiedState] = useState<UnifiedPeopleState>(INITIAL_UNIFIED_STATE);
  const unifiedRequestRef = useRef(0);
  const unifiedAbortRef = useRef<AbortController | null>(null);
  /** Mirrors the unified view's current sort choice so the scope-change effect below can reload with it WITHOUT taking a stale-closure dependency on `unifiedState` itself (which would otherwise refire the effect on every sort change, double-fetching). */
  const unifiedSortRef = useRef<{ sortKey: PeopleListSortKey; sortOrder: SortOrder }>({ sortKey: "totalComplaints", sortOrder: "desc" });

  /**
   * Shared by the flat and unified views — both paginate and sort SERVER-
   * side (never load every person for every facility up front), reusing the
   * same `getRepeatComplainantPeoplePage` endpoint as the pre-existing
   * region-hierarchy view. `facility` present scopes everything to that one
   * facility; absent, it's the org-wide unified list (repeat-complainant-
   * people-service.ts's two modes).
   */
  const fetchPeoplePageFor = useCallback(
    async (
      opts: { facility?: string; page: number; sortKey: PeopleListSortKey; sortOrder: SortOrder },
      signal: AbortSignal
    ): Promise<RepeatComplainantPeopleData> => {
      const params = buildBaseParams();
      if (opts.facility) params.set("facility", opts.facility);
      params.set("peoplePage", String(opts.page));
      params.set("peoplePageSize", String(PEOPLE_LIST_PAGE_SIZE));
      params.set("peopleSortBy", opts.sortKey);
      params.set("peopleSortOrder", opts.sortOrder);
      const res = await fetch(`/api/analytics/repeat-complainants/people?${params.toString()}`, { signal });
      const payload = await readJsonResponse(res);
      if (!res.ok) throw new Error(apiErrorMessage(payload, "تعذر تحميل قائمة الأشخاص."));
      if (!isRepeatComplainantPeopleData(payload)) throw new Error("استجابة قائمة الأشخاص غير مكتملة.");
      return payload;
    },
    [buildBaseParams]
  );

  const loadFlatPeople = useCallback(
    (facility: string, page: number, sortKey: PeopleListSortKey, sortOrder: SortOrder) => {
      flatAbortRefs.current.get(facility)?.abort();
      const controller = new AbortController();
      flatAbortRefs.current.set(facility, controller);
      setFlatPeople((prev) => ({
        ...prev,
        [facility]: { loading: true, error: null, data: prev[facility]?.data ?? null, page, sortKey, sortOrder },
      }));
      fetchPeoplePageFor({ facility, page, sortKey, sortOrder }, controller.signal)
        .then((payload) => {
          if (controller.signal.aborted) return;
          setFlatPeople((prev) => ({ ...prev, [facility]: { loading: false, error: null, data: payload, page, sortKey, sortOrder } }));
        })
        .catch((e) => {
          if (isAbortError(e) || controller.signal.aborted) return;
          setFlatPeople((prev) => ({
            ...prev,
            [facility]: { loading: false, error: e instanceof Error ? e.message : "تعذر تحميل قائمة الأشخاص.", data: null, page, sortKey, sortOrder },
          }));
        });
    },
    [fetchPeoplePageFor]
  );

  const toggleFlatFacility = useCallback(
    (facility: string) => {
      const willOpen = !flatExpanded.has(facility);
      setFlatExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(facility)) next.delete(facility);
        else next.add(facility);
        return next;
      });
      if (willOpen) {
        if (!flatPeople[facility]) loadFlatPeople(facility, 1, "totalComplaints", "desc");
      } else {
        flatAbortRefs.current.get(facility)?.abort();
      }
    },
    [flatExpanded, flatPeople, loadFlatPeople]
  );

  const loadUnified = useCallback(
    (page: number, sortKey: PeopleListSortKey, sortOrder: SortOrder) => {
      unifiedSortRef.current = { sortKey, sortOrder };
      unifiedAbortRef.current?.abort();
      const requestId = unifiedRequestRef.current + 1;
      unifiedRequestRef.current = requestId;
      const controller = new AbortController();
      unifiedAbortRef.current = controller;
      setUnifiedState((prev) => ({ ...prev, loading: true, error: null, page, sortKey, sortOrder }));
      fetchPeoplePageFor({ page, sortKey, sortOrder }, controller.signal)
        .then((payload) => {
          if (unifiedRequestRef.current !== requestId || controller.signal.aborted) return;
          setUnifiedState({ loading: false, error: null, data: payload, page, sortKey, sortOrder });
        })
        .catch((e) => {
          if (isAbortError(e) || unifiedRequestRef.current !== requestId || controller.signal.aborted) return;
          setUnifiedState({ loading: false, error: e instanceof Error ? e.message : "تعذر تحميل القائمة الموحدة.", data: null, page, sortKey, sortOrder });
        });
    },
    [fetchPeoplePageFor]
  );

  /**
   * Loads (or reloads, with an AbortController cancelling whatever was
   * in-flight) the unified list whenever the tab becomes active, or the
   * scope changes while it already is. `buildBaseParams` is a stable
   * reference that only changes identity when from/to/regionId/minComplaints/
   * sameTypeOnly/topFacilities change (see the panel's own useCallback), so
   * depending on it here is equivalent to listing those six fields directly.
   *
   * `loadUnified` is invoked from inside a resolved-microtask callback
   * (`Promise.resolve().then(...)`), not as a direct effect-body statement —
   * this is react-hooks/set-state-in-effect's own sanctioned shape ("calling
   * setState in a callback function", not synchronously in the effect body
   * itself): the state update genuinely happens one microtask after this
   * effect commits, so it can never cascade into the SAME render/commit the
   * way a synchronous call would. `cancelled` guards against that deferred
   * callback firing after this exact effect instance was already cleaned up
   * (scope changed again, or the component unmounted, before the microtask ran).
   */
  useEffect(() => {
    if (viewMode !== "unified") return;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      loadUnified(1, unifiedSortRef.current.sortKey, unifiedSortRef.current.sortOrder);
    });
    return () => {
      cancelled = true;
    };
  }, [viewMode, buildBaseParams, loadUnified]);

  /**
   * A period/region/local-filter change invalidates the flat- and unified-
   * view caches built under the OLD scope, and cancels whatever fetch was
   * still in flight under it — without this, a late response could
   * resurrect stale data into the just-cleared caches. The abort calls are
   * genuine external-system side effects (safe directly in the effect); the
   * state resets are deferred to a microtask for the same reason as above.
   */
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setFlatExpanded(new Set());
      setFlatPeople({});
      setUnifiedState((prev) => ({ ...prev, data: null, page: 1 }));
    });
    return () => {
      cancelled = true;
      for (const pending of flatAbortRefs.current.values()) pending.abort();
      flatAbortRefs.current.clear();
      unifiedAbortRef.current?.abort();
    };
  }, [buildBaseParams]);

  return {
    flatExpanded,
    flatPeople,
    toggleFlatFacility,
    loadFlatPeople,
    unifiedState,
    loadUnified,
  };
}
