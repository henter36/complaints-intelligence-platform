import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  ClassificationSemanticCatalog,
  FinalLlmOutcome,
  GovernedClassificationResult,
  LlmStructuredProvider,
  LlmTokenUsage,
} from "./llm-classification-contract";
import { LLM_CLASSIFICATION_PROMPT_VERSION } from "./llm-classification-contract";
import { selectStratifiedComplaints } from "./llm-classification-gold-set";
import {
  computeLlmClassificationCacheKey,
  runGovernedLlmClassification,
  sanitizeComplaintForClassification,
} from "./llm-classification-service";
import {
  assertSemanticCatalogCurrent,
  retrieveClassificationCandidates,
} from "./classification-semantic-catalog";
import { mapWithConcurrency } from "./llm-classification-reliability";
import {
  readLlmClassificationJson,
  writeLlmClassificationJson,
} from "./llm-classification-artifacts";

export const DEFAULT_LLM_PILOT_LIMIT = 1_000;
export const MAX_LLM_PILOT_LIMIT = 1_000;

type PilotComplaint = Awaited<ReturnType<typeof loadPilotComplaints>>[number];

type PilotStateItem = {
  complaintId: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  result: GovernedClassificationResult | null;
};

type PilotState = {
  schemaVersion: 1;
  runId: string;
  model: string;
  promptVersion: string;
  taxonomyFingerprint: string;
  semanticCatalogFingerprint: string;
  items: PilotStateItem[];
};

type PilotCache = Record<string, GovernedClassificationResult>;

export type PilotEstimate = {
  complaints: number;
  estimatedInputChars: number;
  estimatedInputTokens: number;
  estimatedRequestsUpperBound: number;
  averageCandidateCount: number;
};

export type PilotArtifact = {
  schemaVersion: 1;
  mode: "SMOKE" | "PILOT";
  runId: string;
  model: string;
  taxonomyFingerprint: string;
  promptVersion: string;
  semanticCatalogFingerprint: string;
  startedAt: string;
  completedAt: string;
  scannedCount: number;
  counts: Record<FinalLlmOutcome, number>;
  transitionSummary: Array<{
    fromClassificationId: string | null;
    toClassificationId: string;
    count: number;
  }>;
  classifierVerifierAgreement: number;
  estimate: PilotEstimate;
  tokenUsage: LlmTokenUsage;
};

export type PrivatePilotReview = {
  schemaVersion: 1;
  runId: string;
  items: Array<{
    opaqueId: string;
    sanitizedSubject: string;
    sanitizedDescription: string;
    currentClassificationId: string | null;
    proposedClassificationId: string | null;
    outcome: FinalLlmOutcome;
    classifierShortReason: string | null;
    verifierShortReason: string | null;
  }>;
};

export type RunPilotInput = {
  db: PrismaClient;
  catalog: ClassificationSemanticCatalog;
  provider: LlmStructuredProvider;
  model: string;
  timeoutMs: number;
  limit?: number;
  concurrency?: number;
  smoke?: boolean;
  evaluationGate?: {
    status: "PILOT_APPROVED" | "PILOT_NOT_APPROVED";
    model: string;
    promptVersion: string;
    taxonomyFingerprint: string;
    semanticCatalogFingerprint: string;
  };
  statePath: string;
  cachePath: string;
  artifactPath: string;
  privateReviewPath: string;
  now?: () => Date;
};

async function loadPilotComplaints(db: PrismaClient) {
  return db.complaint.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      sourceDetail: true,
      subject: true,
      description: true,
      classificationId: true,
      categoryId: true,
      classification: { select: { nameAr: true } },
      category: { select: { nameAr: true } },
    },
    orderBy: { id: "asc" },
  });
}

function emptyOutcomeCounts(): Record<FinalLlmOutcome, number> {
  return {
    KEEP: 0,
    CHANGE_CONFIRMED: 0,
    REVIEW: 0,
    UNRESOLVED: 0,
    INVALID_OUTPUT: 0,
    API_FAILED: 0,
  };
}

function emptyTokenUsage(): LlmTokenUsage {
  return {
    classifierInputTokens: 0,
    classifierOutputTokens: 0,
    verifierInputTokens: 0,
    verifierOutputTokens: 0,
    totalRequests: 0,
  };
}

function addUsage(total: LlmTokenUsage, current: LlmTokenUsage): void {
  total.classifierInputTokens += current.classifierInputTokens;
  total.classifierOutputTokens += current.classifierOutputTokens;
  total.verifierInputTokens += current.verifierInputTokens;
  total.verifierOutputTokens += current.verifierOutputTokens;
  total.totalRequests += current.totalRequests;
}

function stateMatches(input: {
  state: PilotState;
  model: string;
  catalog: ClassificationSemanticCatalog;
}): boolean {
  return input.state.model === input.model &&
    input.state.promptVersion === LLM_CLASSIFICATION_PROMPT_VERSION &&
    input.state.taxonomyFingerprint === input.catalog.taxonomyFingerprint &&
    input.state.semanticCatalogFingerprint === input.catalog.semanticCatalogFingerprint;
}

function loadOptionalJson<T>(path: string): T | null {
  try {
    return readLlmClassificationJson<T>(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function initializeState(input: {
  previous: PilotState | null;
  selected: readonly PilotComplaint[];
  model: string;
  catalog: ClassificationSemanticCatalog;
}): PilotState {
  if (input.previous) {
    if (!stateMatches({ state: input.previous, model: input.model, catalog: input.catalog })) {
      throw new Error("PILOT_RESUME_STATE_STALE");
    }
    const selectedIds = new Set(input.selected.map((item) => item.id));
    const items = input.previous.items.filter((item) => selectedIds.has(item.complaintId));
    const existingIds = new Set(items.map((item) => item.complaintId));
    for (const complaint of input.selected) {
      if (!existingIds.has(complaint.id)) {
        items.push({ complaintId: complaint.id, status: "PENDING", result: null });
      }
    }
    return {
      ...input.previous,
      items,
    };
  }
  return {
    schemaVersion: 1,
    runId: randomUUID(),
    model: input.model,
    promptVersion: LLM_CLASSIFICATION_PROMPT_VERSION,
    taxonomyFingerprint: input.catalog.taxonomyFingerprint,
    semanticCatalogFingerprint: input.catalog.semanticCatalogFingerprint,
    items: input.selected.map((complaint) => ({ complaintId: complaint.id, status: "PENDING", result: null })),
  };
}

function estimatePilot(
  selected: readonly PilotComplaint[],
  catalog: ClassificationSemanticCatalog
): PilotEstimate {
  let characters = 0;
  let candidateCount = 0;
  selected.forEach((complaint, index) => {
    const sanitized = sanitizeComplaintForClassification(complaint, index + 1);
    const candidates = retrieveClassificationCandidates({
      catalog,
      complaint: sanitized,
      currentClassificationId: complaint.classificationId,
    });
    characters += sanitized.sourceDetail.length + sanitized.subject.length +
      sanitized.description.length + JSON.stringify(candidates).length;
    candidateCount += candidates.length;
  });
  return {
    complaints: selected.length,
    estimatedInputChars: characters,
    estimatedInputTokens: Math.ceil(characters / 4),
    estimatedRequestsUpperBound: selected.length * 2,
    averageCandidateCount: selected.length === 0 ? 0 : candidateCount / selected.length,
  };
}

function cacheKeyFor(input: {
  complaint: PilotComplaint;
  sequence: number;
  catalog: ClassificationSemanticCatalog;
  model: string;
}): { key: string; sanitized: ReturnType<typeof sanitizeComplaintForClassification> } {
  const sanitized = sanitizeComplaintForClassification(input.complaint, input.sequence);
  const candidates = retrieveClassificationCandidates({
    catalog: input.catalog,
    complaint: sanitized,
    currentClassificationId: input.complaint.classificationId,
  });
  return {
    sanitized,
    key: computeLlmClassificationCacheKey({
      complaint: sanitized,
      currentClassificationId: input.complaint.classificationId,
      currentCategoryId: input.complaint.categoryId,
      candidateClassificationIds: candidates.map((entry) => entry.classificationId),
      model: input.model,
      taxonomyFingerprint: input.catalog.taxonomyFingerprint,
      semanticCatalogFingerprint: input.catalog.semanticCatalogFingerprint,
    }),
  };
}

async function classifyPilotComplaint(input: {
  complaint: PilotComplaint;
  sequence: number;
  catalog: ClassificationSemanticCatalog;
  provider: LlmStructuredProvider;
  model: string;
  timeoutMs: number;
  cache: PilotCache;
}): Promise<{ result: GovernedClassificationResult; cacheKey: string }> {
  const prepared = cacheKeyFor(input);
  const cached = input.cache[prepared.key];
  if (cached) {
    return {
      result: { ...cached, usage: emptyTokenUsage() },
      cacheKey: prepared.key,
    };
  }
  const result = await runGovernedLlmClassification({
    complaint: prepared.sanitized,
    currentClassificationId: input.complaint.classificationId,
    currentCategoryId: input.complaint.categoryId,
    catalog: input.catalog,
    provider: input.provider,
    model: input.model,
    timeoutMs: input.timeoutMs,
  });
  return { result, cacheKey: prepared.key };
}

function buildTransitions(
  selectedById: Map<string, PilotComplaint>,
  state: PilotState
): PilotArtifact["transitionSummary"] {
  const transitions = new Map<string, PilotArtifact["transitionSummary"][number]>();
  for (const item of state.items) {
    const result = item.result;
    if (result?.outcome !== "CHANGE_CONFIRMED" || !result.proposedClassificationId) continue;
    const currentId = selectedById.get(item.complaintId)?.classificationId ?? null;
    const key = `${currentId ?? "NULL"}:${result.proposedClassificationId}`;
    const transition = transitions.get(key) ?? {
      fromClassificationId: currentId,
      toClassificationId: result.proposedClassificationId,
      count: 0,
    };
    transition.count += 1;
    transitions.set(key, transition);
  }
  return [...transitions.values()].sort((left, right) => right.count - left.count);
}

function validatePilotInput(input: RunPilotInput): number {
  const limit = input.limit ?? DEFAULT_LLM_PILOT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LLM_PILOT_LIMIT) {
    throw new Error("PILOT_LIMIT_INVALID");
  }
  if (!input.smoke) validateEvaluationGate(input);
  return limit;
}

function validateEvaluationGate(input: RunPilotInput): void {
  const gate = input.evaluationGate;
  const valid = gate?.status === "PILOT_APPROVED" &&
    gate.model === input.model &&
    gate.promptVersion === LLM_CLASSIFICATION_PROMPT_VERSION &&
    gate.taxonomyFingerprint === input.catalog.taxonomyFingerprint &&
    gate.semanticCatalogFingerprint === input.catalog.semanticCatalogFingerprint;
  if (!valid) throw new Error("PILOT_NOT_APPROVED");
}

async function processPilotStateItem(input: {
  stateItem: PilotStateItem;
  selectedById: ReadonlyMap<string, PilotComplaint>;
  sequenceById: ReadonlyMap<string, number>;
  pilot: RunPilotInput;
  cache: PilotCache;
}) {
  const complaint = input.selectedById.get(input.stateItem.complaintId);
  if (!complaint) throw new Error("PILOT_STATE_COMPLAINT_MISSING");
  const sequence = input.sequenceById.get(complaint.id);
  if (!sequence) throw new Error("PILOT_SEQUENCE_MISSING");
  try {
    const classified = await classifyPilotComplaint({ ...input.pilot, complaint, sequence, cache: input.cache });
    const status = classified.result.outcome === "API_FAILED" ? "FAILED" as const : "COMPLETED" as const;
    return { stateItem: input.stateItem, ...classified, status };
  } catch {
    return {
      stateItem: input.stateItem,
      result: null,
      cacheKey: null,
      status: "FAILED" as const,
    };
  }
}

async function processPendingPilotBatches(input: {
  pilot: RunPilotInput;
  state: PilotState;
  cache: PilotCache;
  selectedById: ReadonlyMap<string, PilotComplaint>;
  sequenceById: ReadonlyMap<string, number>;
}): Promise<void> {
  const pending = input.state.items.filter((item) => item.status === "PENDING");
  const concurrency = input.pilot.concurrency ?? 3;
  writeLlmClassificationJson(input.pilot.statePath, input.state, { private: true });

  for (let offset = 0; offset < pending.length; offset += concurrency) {
    const batch = pending.slice(offset, offset + concurrency);
    const processed = await mapWithConcurrency(batch, concurrency, (stateItem) =>
      processPilotStateItem({
        stateItem,
        selectedById: input.selectedById,
        sequenceById: input.sequenceById,
        pilot: input.pilot,
        cache: input.cache,
      })
    );
    for (const item of processed) {
      item.stateItem.status = item.status;
      item.stateItem.result = item.result;
      if (item.cacheKey && item.result) input.cache[item.cacheKey] = item.result;
    }
    writeLlmClassificationJson(input.pilot.statePath, input.state, { private: true });
    writeLlmClassificationJson(input.pilot.cachePath, input.cache, { private: true });
  }
}

function summarizePilotState(state: PilotState): {
  counts: Record<FinalLlmOutcome, number>;
  tokenUsage: LlmTokenUsage;
  agreement: number;
} {
  const counts = emptyOutcomeCounts();
  const tokenUsage = emptyTokenUsage();
  let agreements = 0;
  let compared = 0;
  for (const item of state.items) {
    if (!item.result) {
      counts.API_FAILED += 1;
      continue;
    }
    counts[item.result.outcome] += 1;
    addUsage(tokenUsage, item.result.usage);
    if (item.result.classifierVerifierAgreement !== null) {
      compared += 1;
      if (item.result.classifierVerifierAgreement) agreements += 1;
    }
  }
  return {
    counts,
    tokenUsage,
    agreement: compared === 0 ? 0 : agreements / compared,
  };
}

function buildPrivatePilotReview(
  state: PilotState,
  selectedById: ReadonlyMap<string, PilotComplaint>,
  sequenceById: ReadonlyMap<string, number>
): PrivatePilotReview {
  return {
    schemaVersion: 1,
    runId: state.runId,
    items: state.items.flatMap((item) => {
      if (!item.result || !["CHANGE_CONFIRMED", "REVIEW"].includes(item.result.outcome)) return [];
      const complaint = selectedById.get(item.complaintId);
      if (!complaint) return [];
      const sequence = sequenceById.get(complaint.id);
      if (!sequence) throw new Error("PILOT_SEQUENCE_MISSING");
      const sanitized = sanitizeComplaintForClassification(complaint, sequence);
      return [{
        opaqueId: sanitized.opaqueId,
        sanitizedSubject: sanitized.subject,
        sanitizedDescription: sanitized.description,
        currentClassificationId: complaint.classificationId,
        proposedClassificationId: item.result.proposedClassificationId,
        outcome: item.result.outcome,
        classifierShortReason: item.result.classifier?.shortReason ?? null,
        verifierShortReason: item.result.verifier?.shortReason ?? null,
      }];
    }),
  };
}

export async function runLlmClassificationPilot(input: RunPilotInput): Promise<PilotArtifact> {
  const limit = validatePilotInput(input);
  await assertSemanticCatalogCurrent(input.db, input.catalog);
  const startedAt = (input.now?.() ?? new Date()).toISOString();
  const pool = await loadPilotComplaints(input.db);
  const selected = selectStratifiedComplaints(pool, Math.min(limit, pool.length));
  const selectedById = new Map(selected.map((complaint) => [complaint.id, complaint]));
  const sequenceById = new Map(selected.map((complaint, index) => [complaint.id, index + 1]));
  const previousState = loadOptionalJson<PilotState>(input.statePath);
  const state = initializeState({ previous: previousState, selected, model: input.model, catalog: input.catalog });
  const cache = loadOptionalJson<PilotCache>(input.cachePath) ?? {};
  await processPendingPilotBatches({ pilot: input, state, cache, selectedById, sequenceById });
  const summary = summarizePilotState(state);
  const artifact: PilotArtifact = {
    schemaVersion: 1,
    mode: input.smoke ? "SMOKE" : "PILOT",
    runId: state.runId,
    model: input.model,
    taxonomyFingerprint: input.catalog.taxonomyFingerprint,
    promptVersion: LLM_CLASSIFICATION_PROMPT_VERSION,
    semanticCatalogFingerprint: input.catalog.semanticCatalogFingerprint,
    startedAt,
    completedAt: (input.now?.() ?? new Date()).toISOString(),
    scannedCount: state.items.length,
    counts: summary.counts,
    transitionSummary: buildTransitions(selectedById, state),
    classifierVerifierAgreement: summary.agreement,
    estimate: estimatePilot(selected, input.catalog),
    tokenUsage: summary.tokenUsage,
  };
  const privateReview = buildPrivatePilotReview(state, selectedById, sequenceById);
  writeLlmClassificationJson(input.artifactPath, artifact);
  writeLlmClassificationJson(input.privateReviewPath, privateReview, { private: true });
  return artifact;
}

export function pilotSelectionFingerprint(rows: readonly {
  classificationId: string | null;
  categoryId: string | null;
  version: number;
}[]): string {
  return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}
