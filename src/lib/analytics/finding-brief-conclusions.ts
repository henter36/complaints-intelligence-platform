import type { AnalyticalFinding } from "./analytical-finding";
import { buildPatternSnapshotKey, type PatternSnapshot, type PeriodChangeDigest } from "./period-change-digest";
import { rankFindingsForExecutiveBrief } from "./finding-ranking";
import { consolidateFindingsForBrief, type ConsolidatedFindingCard } from "./finding-consolidation";
import { classificationLabelFromEntityName } from "./finding-labels";
import type { BestPracticeCandidateEvaluation } from "./best-practice-candidate";

function classificationLabelOf(finding: AnalyticalFinding): string | null {
  if (finding.entityType !== "CLASSIFICATION") return null;
  return classificationLabelFromEntityName(finding.entityName);
}

/**
 * Diversifies the top conclusions by classification (spec §17: "facility +
 * classification + findingType") so three near-identical composition-shift
 * or chronic-issue sentences about the same classification never crowd out
 * an equally important but different problem — e.g. a repeat-complainant or
 * mass-complaint signal further down the ranked list. Falls back to filling
 * remaining slots from the deferred (repeat-classification) pool only when
 * there truly are not enough diverse candidates, so a slot is never left
 * empty just to enforce variety.
 */
function selectDiversifiedCards(
  cards: readonly ConsolidatedFindingCard[],
  maxFindings: number
): ConsolidatedFindingCard[] {
  const selected: ConsolidatedFindingCard[] = [];
  const deferred: ConsolidatedFindingCard[] = [];
  const usedGroups = new Set<string>();

  for (const card of cards) {
    const groupKey = classificationLabelOf(card.primary) ?? `${card.primary.type}:${card.primary.entityName}`;
    if (usedGroups.has(groupKey)) {
      deferred.push(card);
      continue;
    }
    usedGroups.add(groupKey);
    selected.push(card);
    if (selected.length >= maxFindings) return selected;
  }
  for (const card of deferred) {
    if (selected.length >= maxFindings) break;
    selected.push(card);
  }
  return selected;
}

/**
 * Turns the pattern-analysis engine's own output into a handful of short
 * Arabic sentences for the brief PDF's existing conclusions list (spec §1,
 * §2) — never re-derived text, always the engine's `explanation` verbatim,
 * and capped small enough to fit the brief's existing conclusions budget
 * without flooding it with detail. Findings about the same facility×
 * classification are consolidated first (spec §15) so a chronic issue and
 * its own wing-concentration/repeat signal never produce two redundant
 * sentences.
 */
export function buildPatternAnalysisBriefConclusions(
  patternAnalysis: { findings: readonly AnalyticalFinding[]; periodChangeDigest: PeriodChangeDigest | null } | undefined,
  maxFindings = 2,
  /**
   * The report's own authoritative candidate list — the SAME one the best-
   * practice-candidate table and summary sentence are built from (see
   * report-executive-brief-data-service.ts). Passed in rather than
   * re-derived so the digest sentence below can never disagree with the
   * table about which facility×classification pairs are candidates.
   */
  bestPracticeCandidateEvaluations: readonly BestPracticeCandidateEvaluation[] = []
): string[] {
  if (!patternAnalysis) return [];

  const cards = consolidateFindingsForBrief(rankFindingsForExecutiveBrief(patternAnalysis.findings));
  const diversifiedCards = selectDiversifiedCards(cards, maxFindings);
  const topFindingLines = diversifiedCards.map((card) =>
    card.additionalSignalLabels.length > 0
      ? `${card.primary.explanation} (+ ${card.additionalSignalLabels.join("، ")})`
      : card.primary.explanation
  );

  const bestPracticeCandidateCount = patternAnalysis.periodChangeDigest
    ? countBestPracticeCandidatesAmongImproved(patternAnalysis.periodChangeDigest.improvedFacilities, bestPracticeCandidateEvaluations)
    : 0;
  const digestLine = patternAnalysis.periodChangeDigest
    ? buildDigestSummarySentence(patternAnalysis.periodChangeDigest, bestPracticeCandidateCount)
    : null;

  return digestLine ? [...topFindingLines, digestLine] : topFindingLines;
}

/**
 * Of the facility×classification pairs the digest already flags as newly-
 * SUSTAINED_IMPROVEMENT this period, how many DISTINCT SITES are ALSO
 * present in `bestPracticeCandidateEvaluations` — the report's own single
 * source of truth for candidacy (spec item 8's "...منها 3 مواقع مرشحة
 * لدراسة ممارسات ناجحة" — never worded as "ممارسات قابلة للتعميم";
 * generalizability is never claimed by the report itself). Matches on the
 * SAME canonical facility×classificationId key
 * (`buildPatternSnapshotKey(evaluation.facility, evaluation.classificationId)`)
 * the candidate table itself is deduplicated by — never re-runs
 * evaluateBestPracticeCandidacy independently, so this sentence can never
 * name a different count than the table it is describing. Counts unique
 * FACILITIES, not facility×classification rows: one site qualifying in two
 * classifications is still one site.
 */
function countBestPracticeCandidatesAmongImproved(
  improvedFacilities: readonly PatternSnapshot[],
  bestPracticeCandidateEvaluations: readonly BestPracticeCandidateEvaluation[]
): number {
  if (improvedFacilities.length === 0 || bestPracticeCandidateEvaluations.length === 0) return 0;

  const candidateKeys = new Set(
    bestPracticeCandidateEvaluations.map((e) => buildPatternSnapshotKey(e.facility, e.classificationId))
  );
  const candidateFacilities = new Set<string>();
  for (const snapshot of improvedFacilities) {
    if (candidateKeys.has(snapshot.key)) candidateFacilities.add(snapshot.facility);
  }
  return candidateFacilities.size;
}

type CountedNounForms = { singular: string; dual: string; plural: string };

/**
 * Arabic count-noun agreement (spec §16): 1 → singular, 2 → dual, 3-10 →
 * plural, 11+ reverts to the singular noun form grammatically — e.g. "38
 * إشارة ناشئة" but "10 حالات عادت للارتفاع بعد تحسن".
 */
function formatArabicCountPhrase(count: number, forms: CountedNounForms): string {
  const noun = count === 1 ? forms.singular : count === 2 ? forms.dual : count >= 3 && count <= 10 ? forms.plural : forms.singular;
  return `${count} ${noun}`;
}

/**
 * "ما تغير منذ الفترة السابقة" (spec §16): a brand-new pattern-analysis
 * finding is a signal worth watching, not a confirmed operational
 * "مشكلة" — so newProblems is worded as an emerging signal, never asserted
 * as a settled problem.
 */
function buildDigestSummarySentence(digest: PeriodChangeDigest, bestPracticeCandidateCount: number): string | null {
  const parts: string[] = [];
  if (digest.newProblems.length > 0) {
    parts.push(
      formatArabicCountPhrase(digest.newProblems.length, {
        singular: "إشارة ناشئة",
        dual: "إشارتان ناشئتان",
        plural: "إشارات ناشئة",
      })
    );
  }
  if (digest.worsenedProblems.length > 0) {
    parts.push(
      formatArabicCountPhrase(digest.worsenedProblems.length, {
        singular: "مشكلة تفاقمت",
        dual: "مشكلتان تفاقمتا",
        plural: "مشكلات تفاقمت",
      })
    );
  }
  if (digest.relapsedProblems.length > 0) {
    parts.push(
      formatArabicCountPhrase(digest.relapsedProblems.length, {
        singular: "حالة عادت للارتفاع بعد تحسن",
        dual: "حالتان عادتا للارتفاع بعد تحسن",
        plural: "حالات عادت للارتفاع بعد تحسن",
      })
    );
  }
  // Unique FACILITIES, not facility×classification snapshot rows — the same
  // site improving in two classifications must count once here too (spec:
  // "لا تستخدم عدد rows عندما تكون العبارة تقول مواقع").
  const uniqueImprovedFacilityCount = new Set(digest.improvedFacilities.map((s) => s.facility)).size;
  if (uniqueImprovedFacilityCount > 0) {
    parts.push(
      formatArabicCountPhrase(uniqueImprovedFacilityCount, {
        singular: "موقع حقق تحسناً مستداماً",
        dual: "موقعان حققا تحسناً مستداماً",
        plural: "مواقع حققت تحسناً مستداماً",
      })
    );
  }
  if (parts.length === 0) return null;

  let sentence = `ما تغير منذ الفترة السابقة: ${parts.join("، ")}`;
  if (uniqueImprovedFacilityCount > 0 && bestPracticeCandidateCount > 0) {
    sentence += `، منها ${formatArabicCountPhrase(bestPracticeCandidateCount, {
      singular: "موقع مرشح لدراسة ممارسة ناجحة",
      dual: "موقعان مرشحان لدراسة ممارسات ناجحة",
      plural: "مواقع مرشحة لدراسة ممارسات ناجحة",
    })}`;
  }
  return `${sentence}.`;
}
