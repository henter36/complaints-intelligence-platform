import { isNegativeTrend, type TrendPattern } from "./multi-period-trend";
import type { PriorityBand } from "./priority-score";

/**
 * "What changed since the previous period?" (spec §13) — a diff between two
 * snapshots of the same facility×classification pattern analysis, one
 * evaluated as of the current period and one as of the prior period. Kept
 * separate from the detectors themselves so the executive summary can stay
 * short while the full report keeps every underlying finding.
 */
export type PatternSnapshot = {
  key: string;
  facility: string;
  classificationLabel: string;
  pattern: TrendPattern;
  priorityBand: PriorityBand;
};

/** Sentinel for the "no classification" bucket in a PatternSnapshot key — a facility×classification pair with a null classificationId always maps to this single shared bucket, never a per-caller-invented string. */
export const UNCLASSIFIED_PATTERN_SNAPSHOT_KEY = "UNCLASSIFIED";

/**
 * Canonical facility×classification identity for a PatternSnapshot.
 * pattern-findings-service.ts uses this when CREATING a snapshot;
 * finding-brief-conclusions.ts (or any other caller) must use the SAME
 * function when LOOKING one up — never facility+classificationLabel (a
 * display string, not an identity: two differently-labeled classifications
 * could collide, or the same classification could fail to match after a
 * rename) — so the two can never silently drift apart.
 */
export function buildPatternSnapshotKey(facility: string, classificationId: string | null): string {
  return `${facility} ${classificationId ?? UNCLASSIFIED_PATTERN_SNAPSHOT_KEY}`;
}

export type WorsenedProblem = {
  key: string;
  facility: string;
  classificationLabel: string;
  from: PriorityBand;
  to: PriorityBand;
};

export type PeriodChangeDigest = {
  newProblems: PatternSnapshot[];
  continuingProblems: PatternSnapshot[];
  worsenedProblems: WorsenedProblem[];
  relapsedProblems: PatternSnapshot[];
  improvedFacilities: PatternSnapshot[];
  exitedPriorityList: PatternSnapshot[];
  newlySpreadingClassifications: string[];
};

const BAND_RANK: Record<PriorityBand, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function isFlagged(snapshot: PatternSnapshot): boolean {
  return isNegativeTrend(snapshot.pattern) || snapshot.priorityBand !== "LOW";
}

export function buildPeriodChangeDigest(
  current: readonly PatternSnapshot[],
  previous: readonly PatternSnapshot[],
  currentSpreadingClassifications: readonly string[] = [],
  previousSpreadingClassifications: readonly string[] = []
): PeriodChangeDigest {
  const previousByKey = new Map(previous.map((s) => [s.key, s]));
  const currentByKey = new Map(current.map((s) => [s.key, s]));

  const newProblems: PatternSnapshot[] = [];
  const continuingProblems: PatternSnapshot[] = [];
  const worsenedProblems: WorsenedProblem[] = [];
  const relapsedProblems: PatternSnapshot[] = [];
  const improvedFacilities: PatternSnapshot[] = [];

  for (const snapshot of current) {
    if (!isFlagged(snapshot)) continue;
    const prior = previousByKey.get(snapshot.key);

    if (!prior || !isFlagged(prior)) {
      newProblems.push(snapshot);
    } else {
      continuingProblems.push(snapshot);
      if (BAND_RANK[snapshot.priorityBand] > BAND_RANK[prior.priorityBand]) {
        worsenedProblems.push({
          key: snapshot.key,
          facility: snapshot.facility,
          classificationLabel: snapshot.classificationLabel,
          from: prior.priorityBand,
          to: snapshot.priorityBand,
        });
      }
    }

    if (snapshot.pattern === "RELAPSE_AFTER_IMPROVEMENT" && prior?.pattern !== "RELAPSE_AFTER_IMPROVEMENT") {
      relapsedProblems.push(snapshot);
    }
  }

  const exitedPriorityList: PatternSnapshot[] = [];
  for (const prior of previous) {
    if (!isFlagged(prior)) continue;
    const now = currentByKey.get(prior.key);
    if (!now || !isFlagged(now)) {
      exitedPriorityList.push(now ?? prior);
    }
    if (now && now.pattern === "SUSTAINED_IMPROVEMENT" && prior.pattern !== "SUSTAINED_IMPROVEMENT") {
      improvedFacilities.push(now);
    }
  }

  const newlySpreadingClassifications = currentSpreadingClassifications.filter(
    (label) => !previousSpreadingClassifications.includes(label)
  );

  return {
    newProblems,
    continuingProblems,
    worsenedProblems,
    relapsedProblems,
    improvedFacilities,
    exitedPriorityList,
    newlySpreadingClassifications,
  };
}
