"use client";

import { Button } from "@/components/ui/button";

/**
 * Three view modes for the repeat-complainants section. "byFacility" is the
 * primary new addition; "byRegion" is the pre-existing hierarchical browser,
 * kept byte-for-byte (state, tests, behavior) — just one option among three
 * now instead of the only view. Defaults to "byRegion" (set by the caller)
 * so this remains a purely additive change: nothing that already renders on
 * load changes.
 */
export type ViewMode = "unified" | "byFacility" | "byRegion";

export const VIEW_MODE_OPTIONS: { key: ViewMode; label: string }[] = [
  { key: "byRegion", label: "حسب المنطقة ثم السجن" },
  { key: "byFacility", label: "حسب السجن" },
  { key: "unified", label: "قائمة موحدة" },
];

/**
 * A segmented button group, not a Select/dropdown: only three, always-
 * visible, mutually exclusive options, so every mode stays one click away
 * instead of hidden behind a menu. Uses a native `<fieldset>`/`<legend>`
 * pair for the group semantics + accessible name (never a manual
 * `role="group"`) — `<fieldset>` carries an implicit "group" role and
 * `<legend>` supplies its accessible name natively, across every device/AT
 * combination, which a hand-rolled `role`/`aria-label` div does not
 * guarantee equally.
 */
export function RepeatComplainantViewModeSelector({
  value, onChange,
}: Readonly<{ value: ViewMode; onChange: (mode: ViewMode) => void }>) {
  return (
    <fieldset className="m-0 flex flex-wrap items-center gap-3 border-0 p-0">
      <legend className="float-none p-0 text-xs text-muted-foreground">طريقة العرض</legend>
      <div className="flex flex-wrap gap-1.5">
        {VIEW_MODE_OPTIONS.map((opt) => (
          <Button
            key={opt.key}
            type="button"
            size="sm"
            variant={value === opt.key ? "default" : "outline"}
            className="h-8 text-xs"
            aria-pressed={value === opt.key}
            onClick={() => onChange(opt.key)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}
