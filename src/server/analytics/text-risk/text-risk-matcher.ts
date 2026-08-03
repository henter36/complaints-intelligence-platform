import { type ComplaintPriority, type TextRiskSignalType, type TextRiskCertainty } from "@prisma/client";
import { createHash } from "crypto";
import {
  TEXT_RISK_RULES,
  RULE_CATALOG_VERSION,
  EVIDENCE_WINDOW_CHARS,
  resolveCertainty,
  type TextRiskRule,
} from "./text-risk-rule-catalog";
import { buildMatchableText, normalizeForMatching } from "./text-risk-normalize";
import { sanitizeText } from "@/server/ai/ai-data-sanitization-service";

// ---------- Public types ----------

export type TextRiskMatchInput = Readonly<{
  subject: string;
  description: string | null;
}>;

export type TextRiskMatch = Readonly<{
  ruleId: string;
  ruleVersion: string;
  signalType: TextRiskSignalType;
  severity: ComplaintPriority;
  title: string;
  confidenceScore: number;
  certainty: TextRiskCertainty;
  isOngoing: boolean | null;
  evidenceSpans: ReadonlyArray<string>;
  normalizedEvidenceHash: string;
}>;

// ---------- Internal types ----------

type GroupMatchResult = Readonly<{
  matchPos: number;
  matchedGroup: ReadonlyArray<string>;
}>;

// ---------- Internal helpers ----------

/** Returns all char positions where `token` starts in `text`. */
function findTokenPositions(text: string, token: string): number[] {
  const positions: number[] = [];
  let start = 0;
  while (start < text.length) {
    const idx = text.indexOf(token, start);
    if (idx === -1) break;
    positions.push(idx);
    start = idx + 1;
  }
  return positions;
}

/**
 * Returns the position of the first matched group, or null if none match.
 * OR between groups, AND within each group — all tokens must appear within
 * `windowChars` of the first token.
 */
function findFirstGroupMatch(
  text: string,
  groups: ReadonlyArray<ReadonlyArray<string>>,
  windowChars: number
): GroupMatchResult | null {
  for (const group of groups) {
    const firstToken = group[0];
    if (!firstToken) continue;

    const anchorPositions = findTokenPositions(text, firstToken);
    for (const anchorPos of anchorPositions) {
      const winStart = Math.max(0, anchorPos - windowChars);
      const winEnd = Math.min(text.length, anchorPos + firstToken.length + windowChars);
      const window = text.slice(winStart, winEnd);

      const allPresent = group.slice(1).every((t) => window.includes(t));
      if (allPresent) return { matchPos: anchorPos, matchedGroup: group };
    }
  }
  return null;
}

/** Whether any token from `tokens` appears within `windowChars` of `matchPos`. */
function hasTokenNear(
  text: string,
  matchPos: number,
  tokens: ReadonlyArray<string>,
  windowChars: number
): boolean {
  const start = Math.max(0, matchPos - windowChars);
  const end = Math.min(text.length, matchPos + windowChars);
  const window = text.slice(start, end);
  return tokens.some((t) => window.includes(t));
}

/**
 * Extracts a sanitized evidence span around matchPos from the original text.
 * Uses a wider window to compensate for normalization length differences.
 */
function extractSanitizedEvidenceSpan(
  originalText: string,
  matchPos: number
): string {
  const halfWindow = Math.round(EVIDENCE_WINDOW_CHARS * 1.4);
  const start = Math.max(0, matchPos - halfWindow);
  const end = Math.min(originalText.length, matchPos + halfWindow);
  const raw = originalText.slice(start, end).trim();
  try {
    return sanitizeText(raw);
  } catch {
    return "[نص محجوب]";
  }
}

/** SHA-256 of the normalized matched phrase tokens — used for dedup. */
function hashGroup(group: ReadonlyArray<string>): string {
  return createHash("sha256").update(group.join("|")).digest("hex");
}

/** Adjusts confidence based on context modifiers. */
function adjustConfidence(
  base: number,
  hasSuspicion: boolean,
  hasAllegation: boolean,
  isHistorical: boolean,
  hasDescription: boolean
): number {
  let score = base;
  if (hasSuspicion) score *= 0.75;
  else if (hasAllegation) score *= 0.80;
  if (isHistorical) score *= 0.60;
  if (!hasDescription) score *= 0.85;
  return Math.min(1, Math.max(0, Math.round(score * 100) / 100));
}

// ---------- Rule evaluator ----------

function evaluateRule(
  rule: TextRiskRule,
  normalizedText: string,
  originalText: string,
  hasDescription: boolean
): TextRiskMatch | null {
  const groupMatch = findFirstGroupMatch(
    normalizedText,
    rule.primaryGroups,
    rule.groupWindowChars
  );
  if (groupMatch === null) return null;

  const { matchPos, matchedGroup } = groupMatch;
  const contextWindow = rule.negationWindowChars * 2;

  // Hard negation check
  const isNegated = hasTokenNear(normalizedText, matchPos, rule.negationTokens, rule.negationWindowChars);
  if (isNegated) return null;

  const hasSuspicion = hasTokenNear(normalizedText, matchPos, rule.suspicionTokens, contextWindow);
  const hasAllegation = hasTokenNear(normalizedText, matchPos, rule.allegationTokens, contextWindow);
  const isHistorical = hasTokenNear(normalizedText, matchPos, rule.historicalTokens, contextWindow);
  const isOngoingMatch = hasTokenNear(normalizedText, matchPos, rule.ongoingTokens, contextWindow);

  const certainty = resolveCertainty(false, hasSuspicion, hasAllegation, isHistorical);
  const confidence = adjustConfidence(
    rule.baseConfidence,
    hasSuspicion,
    hasAllegation,
    isHistorical,
    hasDescription
  );

  let isOngoing: boolean | null = null;
  if (isOngoingMatch) isOngoing = true;
  else if (isHistorical) isOngoing = false;

  return {
    ruleId: rule.ruleId,
    ruleVersion: RULE_CATALOG_VERSION,
    signalType: rule.signalType,
    severity: rule.severity,
    title: rule.title,
    confidenceScore: confidence,
    certainty,
    isOngoing,
    evidenceSpans: [extractSanitizedEvidenceSpan(originalText, matchPos)],
    normalizedEvidenceHash: hashGroup(matchedGroup),
  };
}

// ---------- Public API ----------

/**
 * Pure function — no side effects, no I/O.
 * Analyzes subject + description against all rules and returns deduplicated matches.
 */
export function matchTextRisks(input: TextRiskMatchInput): TextRiskMatch[] {
  const { text: normalizedText } = buildMatchableText(input.subject, input.description);
  const originalText = `${input.subject} ${input.description ?? ""}`.trim();
  const hasDescription = Boolean(input.description && input.description.trim().length > 0);

  const results: TextRiskMatch[] = [];
  const seenDedupeKeys = new Set<string>();

  for (const rule of TEXT_RISK_RULES) {
    const match = evaluateRule(rule, normalizedText, originalText, hasDescription);
    if (match === null) continue;

    // Prevent duplicate signals for identical (ruleId, normalizedEvidenceHash) pairs.
    const dedupeKey = `${match.ruleId}:${match.normalizedEvidenceHash}`;
    if (seenDedupeKeys.has(dedupeKey)) continue;
    seenDedupeKeys.add(dedupeKey);

    results.push(match);
  }

  return results;
}

/**
 * Computes SHA-256 of the combined normalized subject + description.
 * Used to detect when the source text has changed, triggering re-analysis.
 */
export function computeSourceTextHash(subject: string, description: string | null): string {
  const combined = normalizeForMatching(`${subject}\n${description ?? ""}`);
  return createHash("sha256").update(combined).digest("hex");
}
