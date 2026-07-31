// Structured output contracts for each AI analysis type.
// All schemas are strict: no free text blobs accepted as success.
// z.strictObject() rejects unknown provider fields automatically.

import { z } from "zod";

const MAX_TEXT = 2000;
const MAX_ITEMS = 20;

// Linear HTML check — no /g flag (avoids stateful lastIndex bug on repeated .test() calls).
// The pattern is bounded by {0,1000} to avoid super-linear backtracking on deeply nested tags.
const HTML_TAG_PATTERN = /<[/!]?[A-Za-z][^<>]{0,1000}>/;

const limitedText = (max = MAX_TEXT) =>
  z.string().max(max).refine(s => !HTML_TAG_PATTERN.test(s), "HTML not allowed");

const findingSchema = z.strictObject({
  title: limitedText(200),
  detail: limitedText(MAX_TEXT),
});

// 1. Executive Summary
export const ExecutiveSummaryResultSchema = z.strictObject({
  summary: limitedText(),
  highlights: z.array(limitedText(500)).max(MAX_ITEMS),
  significantChanges: z.array(findingSchema).max(MAX_ITEMS),
  riskAreas: z.array(findingSchema).max(MAX_ITEMS),
  improvementOpportunities: z.array(limitedText(500)).max(MAX_ITEMS),
  questionsForReview: z.array(limitedText(300)).max(10),
  limitations: z.array(limitedText(300)).max(10),
});
export type ExecutiveSummaryResult = z.infer<typeof ExecutiveSummaryResultSchema>;

// 2. Recurring Topics
export const RecurringTopicsResultSchema = z.strictObject({
  summary: limitedText(),
  topics: z.array(z.strictObject({
    label: limitedText(200),
    description: limitedText(),
    estimatedCount: z.number().int().nonnegative(),
    relatedDepartments: z.array(limitedText(200)).max(10),
    relatedRegions: z.array(limitedText(200)).max(10),
    exampleTexts: z.array(limitedText(300)).max(5),
    confidenceNote: limitedText(300),
  })).max(MAX_ITEMS),
  limitations: z.array(limitedText(300)).max(10),
});
export type RecurringTopicsResult = z.infer<typeof RecurringTopicsResultSchema>;

// 3. Possible Root Causes
export const PossibleRootCausesResultSchema = z.strictObject({
  summary: limitedText(),
  causes: z.array(z.strictObject({
    possibleCause: limitedText(500),
    supportingIndicators: z.array(limitedText(300)).max(10),
    counterIndicators: z.array(limitedText(300)).max(10),
    additionalDataNeeded: z.array(limitedText(300)).max(5),
    probabilityNote: limitedText(300),
  })).max(MAX_ITEMS),
  questionsForReview: z.array(limitedText(300)).max(10),
  limitations: z.array(limitedText(300)).max(10),
});
export type PossibleRootCausesResult = z.infer<typeof PossibleRootCausesResultSchema>;

// 4. Anomaly Analysis
export const AnomalyAnalysisResultSchema = z.strictObject({
  summary: limitedText(),
  anomalies: z.array(z.strictObject({
    affectedArea: limitedText(200),
    observedPattern: limitedText(),
    comparedTo: limitedText(300),
    magnitude: limitedText(200),
    possibleExplanations: z.array(limitedText(300)).max(5),
    assistantNote: limitedText(300),
  })).max(MAX_ITEMS),
  overallAssistantNote: limitedText(500),
  limitations: z.array(limitedText(300)).max(10),
});
export type AnomalyAnalysisResult = z.infer<typeof AnomalyAnalysisResultSchema>;

// 5. Improvement Opportunities
export const ImprovementOpportunitiesResultSchema = z.strictObject({
  summary: limitedText(),
  opportunities: z.array(z.strictObject({
    opportunity: limitedText(500),
    relatedProblem: limitedText(500),
    evidence: z.array(limitedText(300)).max(5),
    suggestedPriority: z.enum(["LOW", "MEDIUM", "HIGH"]),
    expectedImpact: limitedText(500),
    suggestedAction: limitedText(500),
    followUpMetric: limitedText(300),
  })).max(MAX_ITEMS),
  limitations: z.array(limitedText(300)).max(10),
});
export type ImprovementOpportunitiesResult = z.infer<typeof ImprovementOpportunitiesResultSchema>;

export type AiAnalysisResult =
  | ExecutiveSummaryResult
  | RecurringTopicsResult
  | PossibleRootCausesResult
  | AnomalyAnalysisResult
  | ImprovementOpportunitiesResult;

export const ANALYSIS_SCHEMAS = {
  EXECUTIVE_SUMMARY: ExecutiveSummaryResultSchema,
  RECURRING_TOPICS: RecurringTopicsResultSchema,
  POSSIBLE_ROOT_CAUSES: PossibleRootCausesResultSchema,
  ANOMALY_ANALYSIS: AnomalyAnalysisResultSchema,
  IMPROVEMENT_OPPORTUNITIES: ImprovementOpportunitiesResultSchema,
} as const;
