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
const PII_PATTERNS: { label: string; pattern: RegExp }[] = [
  // Saudi national/resident ID — 10 digits starting with 1 (citizen) or 2 (iqama).
  // A single pattern covers both; IQAMA is fully included in NATIONAL_ID range.
  { label: "NATIONAL_ID", pattern: /\b[12]\d{9}\b/g },
  // Phone numbers (Saudi local / international variants) — fixed-length patterns only
  { label: "PHONE", pattern: /(?:\+966|00966|0)[0-9 -]{8,10}/g },
  { label: "PHONE", pattern: /\b05\d{8}\b/g },
  // Email addresses — bounded quantifiers prevent O(n²) backtracking on
  // long all-alpha inputs. Local part ≤64 chars and DNS labels ≤63 chars
  // follow RFC 5321. Domain labels use [a-zA-Z0-9-] (no dot), eliminating
  // the dot-overlap ambiguity that made the previous pattern super-linear.
  { label: "EMAIL", pattern: /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9-]{1,63}(?:\.[a-zA-Z0-9-]{1,63})+/g },
  // URLs — terminates at whitespace/quote/angle bracket
  { label: "URL", pattern: /https?:\/\/[^\s"'>]+/g },
  // Secrets / API keys — keyword followed by bounded alphanumeric suffix
  { label: "SECRET", pattern: /(?:sk|pk|api|key|token|secret|password)[-_]?[a-zA-Z0-9]{8,}/gi },
  // Credit card — four explicit fixed-length groups avoids range-quantifier backtracking
  { label: "CARD", pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g },
  // Generic long numeric sequences that may be identifiers
  { label: "IDENTIFIER", pattern: /\b\d{10,}\b/g },
];

// Arabic name detection using label/context prefixes.
// The pattern uses the Unicode flag (u) for correct script matching.
// Prefixes are sorted longest-first so alternation greedily picks the most specific.
// No lookbehind is used for maximum runtime compatibility.
// \s (single space) is used instead of \s+ inside the repeated group to avoid
// a quantifier-inside-quantifier that would flag as potentially super-linear.
// [-] at end of character class avoids unnecessary \- escape.
const ARABIC_NAME_PREFIX =
  /(?:اسم المواطن|اسم المستفيد|اسم مقدم الشكوى|المواطن|المستفيد|الاسم)\s*[:：-]?\s*[؀-ۿ]+(?:\s[؀-ۿ]+){1,5}/gu;

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
  result = result.replace(ARABIC_NAME_PREFIX, "[NAME]");
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
