import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  sanitizeClassificationComplaint,
  type SanitizedClassificationComplaint,
} from "@/server/ai/ai-data-sanitization-service";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import { parseClassificationKeywords } from "./classification-keywords";
import { stableStringify } from "./historical-classification-backfill";
import {
  LLM_CLASSIFICATION_SCHEMA_VERSION,
  type CandidateClassification,
  type ClassificationSemanticCatalog,
  type LlmStructuredProvider,
  type SemanticCatalogEntry,
} from "./llm-classification-contract";
import { computeTaxonomyFingerprint } from "./taxonomy-fingerprint";
import { mapWithConcurrency, withBoundedAiRetry } from "./llm-classification-reliability";

const CATALOG_DEFINITION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["semanticDefinition", "includedConcepts", "excludedConcepts", "confusableWith"],
  properties: {
    semanticDefinition: { type: "string", minLength: 1, maxLength: 800 },
    includedConcepts: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 120 },
    },
    excludedConcepts: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 120 },
    },
    confusableWith: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1 },
    },
  },
};

type DefinitionOutput = {
  semanticDefinition: string;
  includedConcepts: string[];
  excludedConcepts: string[];
  confusableWith: string[];
};

const catalogDefinitionOutputSchema = z.strictObject({
  semanticDefinition: z.string().trim().min(1).max(800),
  includedConcepts: z.array(z.string().trim().min(1).max(120)).max(20),
  excludedConcepts: z.array(z.string().trim().min(1).max(120)).max(20),
  confusableWith: z.array(z.string().min(1)).max(12),
});

type CatalogBuildOptions = {
  db: PrismaClient;
  model: string;
  provider?: LlmStructuredProvider;
  timeoutMs?: number;
  concurrency?: number;
  generatedAt?: Date;
};

export async function loadActiveSemanticTaxonomy(db: PrismaClient) {
  return db.classification.findMany({
    where: {
      isActive: true,
      isDeleted: false,
      category: { isActive: true, isDeleted: false },
    },
    select: {
      id: true,
      nameAr: true,
      description: true,
      keywords: true,
      isActive: true,
      isDeleted: true,
      category: {
        select: {
          id: true,
          nameAr: true,
          isActive: true,
          isDeleted: true,
        },
      },
    },
    orderBy: [
      { category: { displayOrder: "asc" } },
      { displayOrder: "asc" },
      { id: "asc" },
    ],
  });
}

export function computeSemanticCatalogFingerprint(entries: readonly SemanticCatalogEntry[]): string {
  return createHash("sha256").update(stableStringify(entries), "utf8").digest("hex");
}

function buildScaffoldEntry(
  classification: Awaited<ReturnType<typeof loadActiveSemanticTaxonomy>>[number]
): SemanticCatalogEntry {
  const keywords = parseClassificationKeywords(classification.keywords);
  return {
    classificationId: classification.id,
    classificationName: classification.nameAr,
    categoryId: classification.category.id,
    categoryName: classification.category.nameAr,
    keywords,
    semanticDefinition: classification.description?.trim() || null,
    includedConcepts: keywords,
    excludedConcepts: [],
    confusableWith: [],
    status: "DRAFT_REQUIRES_REVIEW",
    generationStatus: "PENDING_LLM_ENRICHMENT",
  };
}

async function loadSanitizedExamples(
  db: PrismaClient,
  classificationIds: readonly string[]
): Promise<Map<string, Array<{ sourceDetail: string; subject: string; description: string }>>> {
  const rows = await db.complaint.findMany({
    where: { isDeleted: false, classificationId: { in: [...classificationIds] } },
    select: { id: true, classificationId: true, sourceDetail: true, subject: true, description: true },
    orderBy: { id: "asc" },
  });
  const ranked = new Map<string, Array<{
    rank: string;
    value: { sourceDetail: string; subject: string; description: string };
  }>>();

  for (const row of rows) {
    if (!row.classificationId) continue;
    const current = ranked.get(row.classificationId) ?? [];
    const sanitized = sanitizeClassificationComplaint(row, "EXAMPLE");
    const value = {
      sourceDetail: sanitized.sourceDetail,
      subject: sanitized.subject,
      description: sanitized.description,
    };
    if (!current.some((entry) => stableStringify(entry.value) === stableStringify(value))) {
      current.push({
        rank: createHash("sha256").update(`catalog-example-v1:${row.id}`).digest("hex"),
        value,
      });
      current.sort((left, right) => left.rank.localeCompare(right.rank, "en"));
      if (current.length > 3) current.pop();
      ranked.set(row.classificationId, current);
    }
  }
  return new Map([...ranked.entries()].map(([classificationId, values]) => [
    classificationId,
    values.map((entry) => entry.value),
  ]));
}

function catalogDefinitionInstructions(): string {
  return [
    "أنشئ مسودة تعريف دلالي لتصنيف إداري اعتمادًا فقط على Taxonomy والأمثلة المنقحة المعطاة.",
    "لا تعتبر الأمثلة صحيحة بالضرورة؛ استخدمها كإشارات فقط.",
    "لا تخترع سياسة رسمية، ولا تدرج بيانات شخصية، واختر confusableWith من IDs المسموحة فقط.",
    "أعد rationale موجزًا ضمن الحقول المطلوبة فقط، ولا تعرض خطوات التفكير.",
  ].join("\n");
}

async function enrichCatalogEntry(input: {
  entry: SemanticCatalogEntry;
  allEntries: readonly SemanticCatalogEntry[];
  examples: readonly { sourceDetail: string; subject: string; description: string }[];
  provider: LlmStructuredProvider;
  model: string;
  timeoutMs: number;
}): Promise<SemanticCatalogEntry> {
  const allowed = input.allEntries.map((entry) => ({
    classificationId: entry.classificationId,
    classificationName: entry.classificationName,
    categoryId: entry.categoryId,
    categoryName: entry.categoryName,
  }));
  const response = await withBoundedAiRetry(() => input.provider({
    model: input.model,
    instructions: catalogDefinitionInstructions(),
    input: JSON.stringify({ classification: input.entry, sanitizedExamples: input.examples, allowed }),
    schemaName: "classification_semantic_definition",
    schema: CATALOG_DEFINITION_SCHEMA,
    timeoutMs: input.timeoutMs,
    maxOutputTokens: 1_200,
  }));
  const parsed = catalogDefinitionOutputSchema.safeParse(response.output);
  if (!parsed.success) throw new Error("SEMANTIC_CATALOG_MODEL_OUTPUT_INVALID");
  const output: DefinitionOutput = parsed.data;
  const allowedIds = new Set(input.allEntries.map((entry) => entry.classificationId));
  const confusableWith = Array.isArray(output.confusableWith)
    ? output.confusableWith.filter((id) => allowedIds.has(id) && id !== input.entry.classificationId)
    : [];

  return {
    ...input.entry,
    semanticDefinition: output.semanticDefinition.slice(0, 800),
    includedConcepts: output.includedConcepts.slice(0, 20),
    excludedConcepts: output.excludedConcepts.slice(0, 20),
    confusableWith,
    generationStatus: "GENERATED_BY_LLM",
  };
}

export async function buildClassificationSemanticCatalog(
  options: CatalogBuildOptions
): Promise<ClassificationSemanticCatalog> {
  const taxonomy = await loadActiveSemanticTaxonomy(options.db);
  const taxonomyFingerprint = computeTaxonomyFingerprint(taxonomy);
  const scaffolds = taxonomy.map(buildScaffoldEntry);
  let entries = scaffolds;

  if (options.provider) {
    const examples = await loadSanitizedExamples(options.db, scaffolds.map((entry) => entry.classificationId));
    entries = await mapWithConcurrency(
      scaffolds,
      options.concurrency ?? 2,
      (entry) => enrichCatalogEntry({
        entry,
        allEntries: scaffolds,
        examples: examples.get(entry.classificationId) ?? [],
        provider: options.provider as LlmStructuredProvider,
        model: options.model,
        timeoutMs: options.timeoutMs ?? 60_000,
      })
    );
  }

  return {
    schemaVersion: LLM_CLASSIFICATION_SCHEMA_VERSION,
    status: "DRAFT_REQUIRES_REVIEW",
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    model: options.provider ? options.model : null,
    taxonomyFingerprint,
    semanticCatalogFingerprint: computeSemanticCatalogFingerprint(entries),
    categoryCount: new Set(entries.map((entry) => entry.categoryId)).size,
    classificationCount: entries.length,
    entries,
  };
}

export async function assertSemanticCatalogCurrent(
  db: PrismaClient,
  catalog: ClassificationSemanticCatalog
): Promise<void> {
  const taxonomy = await loadActiveSemanticTaxonomy(db);
  if (computeTaxonomyFingerprint(taxonomy) !== catalog.taxonomyFingerprint) {
    throw new Error("LLM_CLASSIFICATION_TAXONOMY_CHANGED");
  }
  if (computeSemanticCatalogFingerprint(catalog.entries) !== catalog.semanticCatalogFingerprint) {
    throw new Error("LLM_CLASSIFICATION_CATALOG_FINGERPRINT_INVALID");
  }
}

function terms(value: string): Set<string> {
  return new Set(
    normalizeClassificationKeyword(value)
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

function overlapScore(haystack: Set<string>, phrase: string, weight: number): number {
  const phraseTerms = terms(phrase);
  if (phraseTerms.size === 0) return 0;
  let matched = 0;
  for (const token of phraseTerms) if (haystack.has(token)) matched += 1;
  return matched === phraseTerms.size ? weight : 0;
}

function scorePhrases(
  complaintTerms: Set<string>,
  phrases: readonly string[],
  weight: number,
  reason: string
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const phrase of phrases) {
    const value = overlapScore(complaintTerms, phrase, weight);
    if (value > 0) reasons.push(reason);
    score += value;
  }
  return { score, reasons };
}

function scoreCatalogEntry(input: {
  entry: SemanticCatalogEntry;
  complaintTerms: Set<string>;
  current: SemanticCatalogEntry | undefined;
  currentClassificationId: string | null;
  relatedIds: ReadonlySet<string>;
}): CandidateClassification {
  const reasons: string[] = [];
  let score = overlapScore(input.complaintTerms, input.entry.classificationName, 5);
  if (score > 0) reasons.push("CLASSIFICATION_NAME");
  const keywords = scorePhrases(input.complaintTerms, input.entry.keywords, 4, "KEYWORD");
  const concepts = scorePhrases(
    input.complaintTerms,
    input.entry.includedConcepts,
    2,
    "SEMANTIC_CONCEPT"
  );
  score += keywords.score + concepts.score;
  reasons.push(...keywords.reasons, ...concepts.reasons);
  if (input.entry.classificationId === input.currentClassificationId) {
    score += 1;
    reasons.push("CURRENT_ASSIGNMENT");
  }
  if (
    input.relatedIds.has(input.entry.classificationId) ||
    input.entry.confusableWith.includes(input.currentClassificationId ?? "")
  ) {
    score += 1;
    reasons.push("CONFUSABLE");
  }
  if (input.current && input.entry.categoryId === input.current.categoryId) {
    score += 0.5;
    reasons.push("CURRENT_CATEGORY");
  }
  return { ...input.entry, retrievalScore: score, retrievalReasons: [...new Set(reasons)] };
}

export function retrieveClassificationCandidates(input: {
  catalog: ClassificationSemanticCatalog;
  complaint: Pick<SanitizedClassificationComplaint, "sourceDetail" | "subject" | "description">;
  currentClassificationId: string | null;
  topN?: number;
  broadLimit?: number;
}): CandidateClassification[] {
  const complaintTerms = terms(
    `${input.complaint.sourceDetail} ${input.complaint.subject} ${input.complaint.description}`
  );
  const current = input.catalog.entries.find(
    (entry) => entry.classificationId === input.currentClassificationId
  );
  const relatedIds = new Set(current?.confusableWith ?? []);

  const scored = input.catalog.entries.map((entry) => scoreCatalogEntry({
    entry,
    complaintTerms,
    current,
    currentClassificationId: input.currentClassificationId,
    relatedIds,
  }));

  scored.sort((left, right) =>
    right.retrievalScore - left.retrievalScore ||
    left.classificationId.localeCompare(right.classificationId, "en")
  );
  const topN = input.topN ?? 12;
  const weakRetrieval = (scored[0]?.retrievalScore ?? 0) < 2;
  const limit = weakRetrieval ? (input.broadLimit ?? scored.length) : topN;
  const selected = scored.slice(0, limit);

  if (current && !selected.some((entry) => entry.classificationId === current.classificationId)) {
    selected.push({ ...current, retrievalScore: 1, retrievalReasons: ["CURRENT_ASSIGNMENT"] });
  }
  return selected;
}
