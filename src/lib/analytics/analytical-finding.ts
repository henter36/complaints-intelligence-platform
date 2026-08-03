import { z } from "zod";

export const ANALYTICAL_FINDING_TYPES = [
  "VOLUME_SPIKE",
  "BACKLOG_GROWTH",
  "CURRENTLY_OVERDUE",
  "LATE_CLOSURE",
  "RECURRING_THEME",
  "CONCENTRATION",
  "DATA_QUALITY",
  "TEXT_RISK",
  "EMERGING_TOPIC",
] as const;

export const ANALYTICAL_ENTITY_TYPES = [
  "GLOBAL",
  "REGION",
  "DEPARTMENT",
  "CLASSIFICATION",
  "SUBJECT",
  "FACILITY",
] as const;

export const ANALYTICAL_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export const ANALYTICAL_CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export const ANALYTICAL_DETECTION_SOURCES = [
  "QUANTITATIVE",
  "RULE",
  "MODEL",
  "CLUSTER",
  "MANUAL",
] as const;

const scalarFilterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const AnalyticalFindingSchema = z.strictObject({
  id: z.string().min(1),
  type: z.enum(ANALYTICAL_FINDING_TYPES),
  entityType: z.enum(ANALYTICAL_ENTITY_TYPES),
  entityId: z.string().min(1).nullable(),
  entityName: z.string().min(1).max(300),

  currentValue: z.number().finite().nonnegative(),
  previousValue: z.number().finite().nonnegative().nullable(),
  difference: z.number().finite().nullable(),
  changeRate: z.number().finite().nullable(),

  severity: z.enum(ANALYTICAL_SEVERITIES),
  priorityScore: z.number().finite().min(0).max(100),
  confidence: z.enum(ANALYTICAL_CONFIDENCE_LEVELS),
  detectionSource: z.enum(ANALYTICAL_DETECTION_SOURCES),

  explanation: z.string().min(1).max(2000),
  supportingMetrics: z.record(z.string(), scalarFilterValueSchema),
  evidenceComplaintIds: z.array(z.string().min(1)).max(500),
  evidenceSpans: z.array(z.string().min(1).max(500)).max(20),
  limitations: z.array(z.string().min(1).max(500)).max(20),
  drilldownFilters: z.record(z.string(), scalarFilterValueSchema),

  firstDetectedAt: z.string().datetime(),
  lastDetectedAt: z.string().datetime(),
  detectorVersion: z.string().min(1).max(100),
});

export type AnalyticalFinding = z.infer<typeof AnalyticalFindingSchema>;
export type AnalyticalFindingType = AnalyticalFinding["type"];
export type AnalyticalEntityType = AnalyticalFinding["entityType"];
export type AnalyticalSeverity = AnalyticalFinding["severity"];
export type AnalyticalConfidence = AnalyticalFinding["confidence"];
export type AnalyticalDetectionSource = AnalyticalFinding["detectionSource"];

export function parseAnalyticalFinding(input: unknown): AnalyticalFinding {
  return AnalyticalFindingSchema.parse(input);
}
