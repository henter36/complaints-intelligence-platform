import {
  CHANGE_CONFIRMED_PRECISION_GATE,
  type FinalLlmOutcome,
} from "./llm-classification-contract";
import type { GoldSetSplit } from "./llm-classification-gold-set";
import type { GoldSetReviewArtifact } from "./llm-classification-gold-set";
import type {
  ClassificationSemanticCatalog,
  LlmStructuredProvider,
  LlmTokenUsage,
} from "./llm-classification-contract";
import { runGovernedLlmClassification } from "./llm-classification-service";
import { mapWithConcurrency } from "./llm-classification-reliability";

export const MIN_HOLDOUT_SIZE_FOR_APPROVAL = 90;
export const MIN_EXPECTED_CHANGES_FOR_APPROVAL = 20;

export type EvaluationPrediction = {
  reviewId: string;
  split: GoldSetSplit;
  currentClassificationId: string | null;
  expectedClassificationId: string;
  expectedCategoryId: string;
  outcome: FinalLlmOutcome;
  predictedClassificationId: string | null;
  predictedCategoryId: string | null;
  candidateClassificationIds: string[];
  classifierDecision: "KEEP" | "CHANGE" | "REVIEW" | null;
  classifierVerifierAgreement: boolean | null;
};

export type MetricPair = { precision: number; recall: number; f1: number };

export type LlmClassificationEvaluation = {
  status: "PILOT_APPROVED" | "PILOT_NOT_APPROVED";
  sampleSize: number;
  overallAccuracy: number;
  keep: MetricPair;
  change: MetricPair;
  macroF1: number;
  abstentionRate: number;
  reviewRate: number;
  candidateRetrievalRecall: number;
  classifierVerifierDisagreementRate: number;
  currentAssignmentAgreementRate: number;
  anchoringErrorRate: number;
  perCategoryAccuracy: Record<string, { correct: number; total: number; accuracy: number }>;
  perClassificationAccuracy: Record<string, { correct: number; total: number; accuracy: number }>;
  confusionMatrix: Record<string, Record<string, number>>;
  systematicFailures: string[];
  gate: {
    requiredChangePrecision: number;
    minimumHoldoutSize: number;
    minimumExpectedChanges: number;
    observedExpectedChanges: number;
    passed: boolean;
  };
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function metrics(truePositive: number, predictedPositive: number, actualPositive: number): MetricPair {
  const precision = ratio(truePositive, predictedPositive);
  const recall = ratio(truePositive, actualPositive);
  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

function resolvedPrediction(row: EvaluationPrediction): string {
  if (row.outcome === "KEEP") return row.currentClassificationId ?? "__UNRESOLVED__";
  if (row.outcome === "CHANGE_CONFIRMED") return row.predictedClassificationId ?? "__UNRESOLVED__";
  return `__${row.outcome}__`;
}

function calculatePerGroup(
  rows: readonly EvaluationPrediction[],
  group: (row: EvaluationPrediction) => string
): Record<string, { correct: number; total: number; accuracy: number }> {
  const counts = new Map<string, { correct: number; total: number }>();
  for (const row of rows) {
    const key = group(row);
    const current = counts.get(key) ?? { correct: 0, total: 0 };
    current.total += 1;
    if (resolvedPrediction(row) === row.expectedClassificationId) current.correct += 1;
    counts.set(key, current);
  }
  return Object.fromEntries([...counts.entries()].map(([key, value]) => [key, {
    ...value,
    accuracy: ratio(value.correct, value.total),
  }]));
}

function calculateConfusion(rows: readonly EvaluationPrediction[]): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const expected = row.expectedClassificationId;
    const predicted = resolvedPrediction(row);
    matrix[expected] ??= {};
    matrix[expected][predicted] = (matrix[expected][predicted] ?? 0) + 1;
  }
  return matrix;
}

function macroClassificationF1(rows: readonly EvaluationPrediction[]): number {
  const labels = [...new Set(rows.map((row) => row.expectedClassificationId))];
  if (labels.length === 0) return 0;
  const scores = labels.map((label) => {
    const truePositive = rows.filter(
      (row) => row.expectedClassificationId === label && resolvedPrediction(row) === label
    ).length;
    const predicted = rows.filter((row) => resolvedPrediction(row) === label).length;
    const actual = rows.filter((row) => row.expectedClassificationId === label).length;
    return metrics(truePositive, predicted, actual).f1;
  });
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function findSystematicFailures(rows: readonly EvaluationPrediction[]): string[] {
  const confirmedByTarget = new Map<string, EvaluationPrediction[]>();
  for (const row of rows) {
    if (row.outcome !== "CHANGE_CONFIRMED" || !row.predictedClassificationId) continue;
    const group = confirmedByTarget.get(row.predictedClassificationId) ?? [];
    group.push(row);
    confirmedByTarget.set(row.predictedClassificationId, group);
  }
  const failures: string[] = [];
  for (const [target, group] of confirmedByTarget) {
    if (group.length < 5) continue;
    const correct = group.filter((row) => row.expectedClassificationId === target).length;
    if (ratio(correct, group.length) < 0.9) failures.push(target);
  }
  return failures.sort();
}

export function evaluateLlmClassificationPredictions(
  allRows: readonly EvaluationPrediction[]
): LlmClassificationEvaluation {
  const rows = allRows.filter((row) => row.split === "HOLDOUT");
  const correct = rows.filter((row) => resolvedPrediction(row) === row.expectedClassificationId).length;
  const expectedKeep = rows.filter(
    (row) => row.expectedClassificationId === row.currentClassificationId
  );
  const predictedKeep = rows.filter((row) => row.outcome === "KEEP");
  const correctKeep = predictedKeep.filter(
    (row) => row.expectedClassificationId === row.currentClassificationId
  ).length;
  const expectedChange = rows.filter(
    (row) => row.expectedClassificationId !== row.currentClassificationId
  );
  const predictedChange = rows.filter((row) => row.outcome === "CHANGE_CONFIRMED");
  const correctChange = predictedChange.filter(
    (row) => row.predictedClassificationId === row.expectedClassificationId
  ).length;
  const classifierChanges = rows.filter((row) => row.classifierDecision === "CHANGE");
  const disagreements = classifierChanges.filter((row) => row.classifierVerifierAgreement !== true).length;
  const systematicFailures = findSystematicFailures(rows);
  const change = metrics(correctChange, predictedChange.length, expectedChange.length);
  const gatePassed = rows.length >= MIN_HOLDOUT_SIZE_FOR_APPROVAL &&
    expectedChange.length >= MIN_EXPECTED_CHANGES_FOR_APPROVAL &&
    change.precision >= CHANGE_CONFIRMED_PRECISION_GATE &&
    systematicFailures.length === 0;

  return {
    status: gatePassed ? "PILOT_APPROVED" : "PILOT_NOT_APPROVED",
    sampleSize: rows.length,
    overallAccuracy: ratio(correct, rows.length),
    keep: metrics(correctKeep, predictedKeep.length, expectedKeep.length),
    change,
    macroF1: macroClassificationF1(rows),
    abstentionRate: ratio(
      rows.filter((row) => !["KEEP", "CHANGE_CONFIRMED"].includes(row.outcome)).length,
      rows.length
    ),
    reviewRate: ratio(rows.filter((row) => row.outcome === "REVIEW").length, rows.length),
    candidateRetrievalRecall: ratio(
      rows.filter((row) => row.candidateClassificationIds.includes(row.expectedClassificationId)).length,
      rows.length
    ),
    classifierVerifierDisagreementRate: ratio(disagreements, classifierChanges.length),
    currentAssignmentAgreementRate: ratio(
      rows.filter((row) => resolvedPrediction(row) === row.currentClassificationId).length,
      rows.length
    ),
    anchoringErrorRate: ratio(
      expectedChange.filter((row) => row.outcome === "KEEP").length,
      expectedChange.length
    ),
    perCategoryAccuracy: calculatePerGroup(rows, (row) => row.expectedCategoryId),
    perClassificationAccuracy: calculatePerGroup(rows, (row) => row.expectedClassificationId),
    confusionMatrix: calculateConfusion(rows),
    systematicFailures,
    gate: {
      requiredChangePrecision: CHANGE_CONFIRMED_PRECISION_GATE,
      minimumHoldoutSize: MIN_HOLDOUT_SIZE_FOR_APPROVAL,
      minimumExpectedChanges: MIN_EXPECTED_CHANGES_FOR_APPROVAL,
      observedExpectedChanges: expectedChange.length,
      passed: gatePassed,
    },
  };
}

export async function runLlmClassificationEvaluation(input: {
  goldSet: GoldSetReviewArtifact;
  catalog: ClassificationSemanticCatalog;
  provider: LlmStructuredProvider;
  model: string;
  timeoutMs: number;
  concurrency?: number;
}): Promise<{
  metrics: LlmClassificationEvaluation;
  predictions: EvaluationPrediction[];
  tokenUsage: LlmTokenUsage;
}> {
  const reviewed = input.goldSet.items.filter(
    (item) => item.humanReviewStatus === "REVIEWED" && item.humanExpectedClassificationId
  );
  if (reviewed.length === 0) throw new Error("GOLD_SET_NOT_YET_LABELED");

  const evaluated = await mapWithConcurrency(
    reviewed,
    input.concurrency ?? 3,
    async (item) => {
      const expected = input.catalog.entries.find(
        (entry) => entry.classificationId === item.humanExpectedClassificationId
      );
      if (!expected) throw new Error("GOLD_SET_EXPECTED_CLASSIFICATION_INVALID");
      const result = await runGovernedLlmClassification({
        complaint: {
          opaqueId: item.reviewId,
          sourceDetail: item.sanitizedSourceDetail,
          subject: item.sanitizedSubject,
          description: item.sanitizedDescription,
        },
        currentClassificationId: item.currentClassificationId,
        currentCategoryId: item.currentCategoryId,
        catalog: input.catalog,
        provider: input.provider,
        model: input.model,
        timeoutMs: input.timeoutMs,
      });
      return {
        prediction: {
          reviewId: item.reviewId,
          split: item.split,
          currentClassificationId: item.currentClassificationId,
          expectedClassificationId: expected.classificationId,
          expectedCategoryId: expected.categoryId,
          outcome: result.outcome,
          predictedClassificationId: result.proposedClassificationId,
          predictedCategoryId: result.proposedCategoryId,
          candidateClassificationIds: result.candidateClassificationIds,
          classifierDecision: result.classifier?.decision ?? null,
          classifierVerifierAgreement: result.classifierVerifierAgreement,
        } satisfies EvaluationPrediction,
        usage: result.usage,
      };
    }
  );
  const predictions = evaluated.map((entry) => entry.prediction);
  const tokenUsage = evaluated.reduce<LlmTokenUsage>((total, entry) => ({
    classifierInputTokens: total.classifierInputTokens + entry.usage.classifierInputTokens,
    classifierOutputTokens: total.classifierOutputTokens + entry.usage.classifierOutputTokens,
    verifierInputTokens: total.verifierInputTokens + entry.usage.verifierInputTokens,
    verifierOutputTokens: total.verifierOutputTokens + entry.usage.verifierOutputTokens,
    totalRequests: total.totalRequests + entry.usage.totalRequests,
  }), {
    classifierInputTokens: 0,
    classifierOutputTokens: 0,
    verifierInputTokens: 0,
    verifierOutputTokens: 0,
    totalRequests: 0,
  });
  return { metrics: evaluateLlmClassificationPredictions(predictions), predictions, tokenUsage };
}
