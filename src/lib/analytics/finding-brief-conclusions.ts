import type { AnalyticalFinding } from "./analytical-finding";
import type { PeriodChangeDigest } from "./period-change-digest";
import { rankFindingsForExecutiveBrief } from "./finding-ranking";
import { consolidateFindingsForBrief, type ConsolidatedFindingCard } from "./finding-consolidation";

function classificationLabelOf(finding: AnalyticalFinding): string | null {
  if (finding.entityType !== "CLASSIFICATION") return null;
  const separatorIndex = finding.entityName.indexOf(" — ");
  return separatorIndex === -1 ? finding.entityName : finding.entityName.slice(separatorIndex + 3);
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
  maxFindings = 2
): string[] {
  if (!patternAnalysis) return [];

  const cards = consolidateFindingsForBrief(rankFindingsForExecutiveBrief(patternAnalysis.findings));
  const diversifiedCards = selectDiversifiedCards(cards, maxFindings);
  const topFindingLines = diversifiedCards.map((card) =>
    card.additionalSignalLabels.length > 0
      ? `${card.primary.explanation} (+ ${card.additionalSignalLabels.join("، ")})`
      : card.primary.explanation
  );

  const digestLine = patternAnalysis.periodChangeDigest ? buildDigestSummarySentence(patternAnalysis.periodChangeDigest) : null;

  return digestLine ? [...topFindingLines, digestLine] : topFindingLines;
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
function buildDigestSummarySentence(digest: PeriodChangeDigest): string | null {
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
  if (digest.improvedFacilities.length > 0) {
    parts.push(
      formatArabicCountPhrase(digest.improvedFacilities.length, {
        singular: "موقع حقق تحسناً مستداماً",
        dual: "موقعان حققا تحسناً مستداماً",
        plural: "مواقع حققت تحسناً مستداماً",
      })
    );
  }
  if (parts.length === 0) return null;
  return `ما تغير منذ الفترة السابقة: ${parts.join("، ")}.`;
}
