import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { artifactTimestamp, readLlmClassificationJson } from "@/server/classifications/llm-classification-artifacts";
import { runLlmClassificationPilot } from "@/server/classifications/llm-classification-pilot";
import { parseLlmClassificationEvaluationArtifact } from "@/server/classifications/llm-classification-evaluation";
import {
  loadSemanticCatalog,
  localArtifactPath,
  parseCliArguments,
  positiveIntegerArgument,
  requiredClassificationProvider,
  runLlmClassificationCli,
} from "./lib/llm-classification-cli";

async function run(): Promise<void> {
  const args = parseCliArguments(process.argv.slice(2));
  const smoke = args.get("smoke") === "true";
  const limit = positiveIntegerArgument(args, "limit", smoke ? 10 : 1_000);
  if (smoke && limit > 20) throw new Error("SMOKE_LIMIT_MUST_NOT_EXCEED_20");
  const catalog = loadSemanticCatalog(args.get("catalog"));
  const evaluationPath = args.get("evaluation");
  const evaluation = evaluationPath
    ? parseLlmClassificationEvaluationArtifact(readLlmClassificationJson<unknown>(evaluationPath))
    : null;
  const timestamp = artifactTimestamp();
  const artifact = await runLlmClassificationPilot({
    db,
    catalog,
    provider: requiredClassificationProvider(),
    model: env.aiClassificationModel,
    timeoutMs: env.aiRequestTimeoutSeconds * 1_000,
    limit,
    smoke,
    evaluationGate: evaluation ? {
      status: evaluation.metrics.status,
      model: evaluation.model,
      promptVersion: evaluation.promptVersion,
      taxonomyFingerprint: evaluation.taxonomyFingerprint,
      semanticCatalogFingerprint: evaluation.semanticCatalogFingerprint,
    } : undefined,
    statePath: args.get("state") ?? localArtifactPath("pilot-state.json"),
    cachePath: args.get("cache") ?? localArtifactPath("llm-cache.json"),
    artifactPath: args.get("output") ?? localArtifactPath(`pilot-${timestamp}.json`),
    privateReviewPath: args.get("private-review") ?? localArtifactPath("private-pilot-review.json"),
  });
  console.log(JSON.stringify({
    mode: artifact.mode,
    runId: artifact.runId,
    scannedCount: artifact.scannedCount,
    counts: artifact.counts,
    classifierVerifierAgreement: artifact.classifierVerifierAgreement,
    tokenUsage: artifact.tokenUsage,
  }));
}

void runLlmClassificationCli({
  run,
  disconnect: () => db.$disconnect(),
});
