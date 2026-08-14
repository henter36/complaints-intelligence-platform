// PII removal before any data reaches the AI provider.
// Rules are deterministic (regex + allowlist) — no AI is used to sanitize.
// All patterns are designed for linear (non-backtracking) execution.

// Hard limit: inputs longer than this are rejected rather than truncated silently.
// Truncation could split a PII token and let it slip through unreplaced.
const MAX_SANITIZATION_INPUT_LENGTH = 100_000;

// Each pattern must be linear (no nested unlimited quantifiers).
// Rationale for each pattern's safety:
//   - NATIONAL_ID/IQAMA: fixed prefix + fixed count — O(n)
//   - PHONE: literal prefixes + fixed max length — O(n)
//   - EMAIL: [local]@[domain].[tld] — no nested groups, O(n)
//   - URL: prefix + non-space chars, terminates at whitespace — O(n)
//   - SECRET: keyword prefix + bounded alphanum suffix — O(n)
//   - CARD: four explicit groups (no range quantifier with alternation) — O(n)
//   - IDENTIFIER: digits only, no alternation — O(n)
// URL and EMAIL are listed first: they are the most specific and must match
// before IDENTIFIER/PHONE/NATIONAL_ID could consume a partial numeric run inside them.
const PII_PATTERNS: { label: string; pattern: RegExp }[] = [
  // URLs — terminates at whitespace/quote/angle bracket
  { label: "URL", pattern: /https?:\/\/[^\s"'>]+/g },
  // Email addresses — bounded quantifiers prevent O(n²) backtracking on
  // long all-alpha inputs. Local part ≤64 chars and DNS labels ≤63 chars
  // follow RFC 5321. Domain labels use [a-z0-9-] (no dot), eliminating
  // the dot-overlap ambiguity that made the previous pattern super-linear.
  // The case-insensitive (i) flag covers uppercase without widening the class.
  { label: "EMAIL", pattern: /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+/gi },
  // Saudi national/resident ID — 10 digits starting with 1 (citizen) or 2 (iqama).
  // A single pattern covers both; IQAMA is fully included in NATIONAL_ID range.
  { label: "NATIONAL_ID", pattern: /\b[12]\d{9}\b/g },
  // Phone numbers (Saudi local / international variants) — fixed-length patterns only
  { label: "PHONE", pattern: /(?:\+966|00966|0)[0-9 -]{8,10}/g },
  { label: "PHONE", pattern: /\b05\d{8}\b/g },
  // Secrets / API keys — keyword followed by bounded alphanumeric suffix
  { label: "SECRET", pattern: /(?:sk|pk|api|key|token|secret|password)[-_]?[a-z0-9]{8,}/gi },
  // Credit card — four explicit fixed-length groups avoids range-quantifier backtracking
  { label: "CARD", pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g },
  // Generic long numeric sequences that may be identifiers
  { label: "IDENTIFIER", pattern: /\b\d{10,}\b/g },
];

// Arabic name detection — two-phase approach to avoid super-linear backtracking.
// Phase 1: detect the prefix label with a simple linear pattern (no quantifiers on name).
// Phase 2: consume bounded Arabic words using a character-by-character scanner.
// Prefixes sorted longest-first so the alternation picks the most specific match.
const ARABIC_NAME_LABEL_PATTERN =
  /(?:اسم مقدم الشكوى|اسم المستفيد|اسم المواطن|المستفيد|المواطن|الاسم)\s*[:：-]?\s*/gu;

const MAX_ARABIC_NAME_WORDS = 5;
const MAX_ARABIC_WORD_LENGTH = 30;
const MIN_ARABIC_WORD_LENGTH = 2;
const ARABIC_SCRIPT_RE = /\p{Script=Arabic}/u;

function isArabicLetter(ch: string): boolean {
  return ARABIC_SCRIPT_RE.test(ch);
}

type ArabicWordScan = Readonly<{
  endIndex: number;
  valid: boolean;
}>;

function resolveArabicWordStart(
  input: string,
  currentIndex: number,
  wordsRead: number
): number | null {
  if (wordsRead === 0) {
    return currentIndex;
  }

  return input[currentIndex] === " "
    ? currentIndex + 1
    : null;
}

function scanArabicWord(
  input: string,
  startIndex: number
): ArabicWordScan {
  let index = startIndex;
  let length = 0;

  while (
    index < input.length &&
    length < MAX_ARABIC_WORD_LENGTH &&
    isArabicLetter(input[index])
  ) {
    index += 1;
    length += 1;
  }

  return {
    endIndex: index,
    valid:
      length >= MIN_ARABIC_WORD_LENGTH,
  };
}

// Scans forward from startIndex consuming between MIN and MAX Arabic words.
// Returns the index past the last consumed character, or startIndex if fewer
// than MIN_ARABIC_WORD_LENGTH valid words are found.
function consumeArabicName(
  input: string,
  startIndex: number
): number {
  let index = startIndex;
  let words = 0;

  while (
    index < input.length &&
    words < MAX_ARABIC_NAME_WORDS
  ) {
    const wordStart =
      resolveArabicWordStart(
        input,
        index,
        words
      );

    if (wordStart === null) {
      break;
    }

    const word =
      scanArabicWord(
        input,
        wordStart
      );

    if (!word.valid) {
      break;
    }

    index = word.endIndex;
    words += 1;
  }

  return words >= MIN_ARABIC_WORD_LENGTH
    ? index
    : startIndex;
}

function redactArabicNames(input: string): string {
  let output = "";
  let cursor = 0;

  for (const match of input.matchAll(ARABIC_NAME_LABEL_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const nameStart = matchIndex + match[0].length;
    const nameEnd = consumeArabicName(input, nameStart);

    if (nameEnd === nameStart) {
      // No valid name after prefix — skip this match
      continue;
    }

    output += input.slice(cursor, matchIndex);
    output += "[NAME]";
    cursor = nameEnd;
  }

  return output + input.slice(cursor);
}

export function sanitizeText(text: string): string {
  if (!text) return text;
  if (text.length > MAX_SANITIZATION_INPUT_LENGTH) {
    throw new Error(
      `sanitizeText: input exceeds maximum length (${MAX_SANITIZATION_INPUT_LENGTH}). ` +
      "Truncate the input before calling sanitizeText."
    );
  }
  let result = text;
  for (const { label, pattern } of PII_PATTERNS) {
    result = result.replace(pattern, `[${label}]`);
  }
  result = redactArabicNames(result);
  return result;
}

export interface ComplaintInputRecord {
  id: string;
  subject: string;
  description?: string | null;
  department?: string | null;
  region?: string | null;
  facility?: string | null;
  status?: string;
  classification?: string | null;
  channel?: string | null;
  complaintDate?: Date | string | null;
  dueDate?: Date | string | null;
}

export interface SanitizedComplaintRecord {
  id: string;
  subject: string;
  description?: string;
  department?: string;
  region?: string;
  facility?: string;
  status?: string;
  classification?: string;
  channel?: string;
  complaintMonth?: string;
  isOverdue?: boolean;
}

export interface ClassificationComplaintInput {
  sourceDetail?: string | null;
  subject: string;
  description?: string | null;
}

export interface SanitizedClassificationComplaint {
  opaqueId: string;
  sourceDetail: string;
  subject: string;
  description: string;
}

const CLASSIFICATION_TEXT_LIMITS = {
  sourceDetail: 500,
  subject: 1_000,
  description: 5_000,
} as const;

// Covers the longest bounded PII token used by classification sanitization,
// including a standards-sized email address, when it crosses a field boundary.
const CLASSIFICATION_PII_BOUNDARY_LOOKAHEAD = 320;

function sanitizeClassificationField(value: string, limit: number): string {
  const sanitizationLimit = Math.min(
    MAX_SANITIZATION_INPUT_LENGTH,
    limit + CLASSIFICATION_PII_BOUNDARY_LOOKAHEAD
  );
  return sanitizeText(value.slice(0, sanitizationLimit)).slice(0, limit);
}

/**
 * Minimal complaint projection allowed in the LLM classification boundary.
 * The caller supplies an opaque request-local ID; database and external IDs are
 * intentionally not accepted by this contract.
 */
export function sanitizeClassificationComplaint(
  input: ClassificationComplaintInput,
  opaqueId: string
): SanitizedClassificationComplaint {
  return {
    opaqueId,
    sourceDetail: sanitizeClassificationField(
      input.sourceDetail ?? "",
      CLASSIFICATION_TEXT_LIMITS.sourceDetail
    ),
    subject: sanitizeClassificationField(input.subject, CLASSIFICATION_TEXT_LIMITS.subject),
    description: sanitizeClassificationField(
      input.description ?? "",
      CLASSIFICATION_TEXT_LIMITS.description
    ),
  };
}

export function sanitizeComplaint(c: ComplaintInputRecord): SanitizedComplaintRecord {
  const overdue = c.dueDate ? new Date(c.dueDate) < new Date() : false;
  const month = c.complaintDate
    ? new Date(c.complaintDate).toISOString().slice(0, 7)
    : undefined;

  // Clamp description to 500 chars before sanitization to stay within input limit
  const rawDescription = c.description ? c.description.slice(0, 500) : undefined;
  const rawSubject = (c.subject ?? "").slice(0, 500);

  return {
    id: c.id,
    subject: sanitizeText(rawSubject),
    description: rawDescription ? sanitizeText(rawDescription) : undefined,
    department: c.department ?? undefined,
    region: c.region ?? undefined,
    facility: c.facility ?? undefined,
    status: c.status,
    classification: c.classification ?? undefined,
    channel: c.channel ?? undefined,
    complaintMonth: month,
    isOverdue: overdue,
  };
}

export interface AggregateStats {
  totalComplaints: number;
  byDepartment: Record<string, number>;
  byRegion: Record<string, number>;
  byClassification: Record<string, number>;
  byStatus: Record<string, number>;
  byChannel: Record<string, number>;
  byMonth: Record<string, number>;
  overdueCount: number;
}

function incrementCount(map: Record<string, number>, key: string | null | undefined): void {
  if (key) map[key] = (map[key] ?? 0) + 1;
}

export function buildAggregateStats(complaints: ComplaintInputRecord[]): AggregateStats {
  const stats: AggregateStats = {
    totalComplaints: complaints.length,
    byDepartment: {},
    byRegion: {},
    byClassification: {},
    byStatus: {},
    byChannel: {},
    byMonth: {},
    overdueCount: 0,
  };

  for (const c of complaints) {
    incrementCount(stats.byDepartment, c.department);
    incrementCount(stats.byRegion, c.region);
    incrementCount(stats.byClassification, c.classification);
    incrementCount(stats.byStatus, c.status);
    incrementCount(stats.byChannel, c.channel);

    const month = c.complaintDate ? new Date(c.complaintDate).toISOString().slice(0, 7) : "unknown";
    stats.byMonth[month] = (stats.byMonth[month] ?? 0) + 1;

    if (c.dueDate && new Date(c.dueDate) < new Date()) stats.overdueCount += 1;
  }

  return stats;
}

export function sanitizeComplaintsForAi(
  complaints: ComplaintInputRecord[],
  maxComplaints: number,
  maxChars: number
): { records: SanitizedComplaintRecord[]; stats: AggregateStats; truncated: boolean } {
  const stats = buildAggregateStats(complaints);
  const sample = complaints.slice(0, maxComplaints);
  const records: SanitizedComplaintRecord[] = [];
  let charCount = 0;
  let truncated = false;

  for (const c of sample) {
    const sanitized = sanitizeComplaint(c);
    const size = JSON.stringify(sanitized).length;
    if (charCount + size > maxChars) {
      truncated = true;
      break;
    }
    records.push(sanitized);
    charCount += size;
  }

  if (complaints.length > maxComplaints) truncated = true;

  return { records, stats, truncated };
}

// Used in unit tests to verify PII detection without full sanitization
export function detectPII(text: string): string[] {
  const found: string[] = [];
  for (const { label, pattern } of PII_PATTERNS) {
    const copy = new RegExp(pattern.source, pattern.flags);
    if (copy.test(text)) found.push(label);
  }
  return found;
}
