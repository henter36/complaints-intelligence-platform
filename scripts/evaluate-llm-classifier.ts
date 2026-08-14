import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { readLlmClassificationJson, writeLlmClassificationJson } from "@/server/classifications/llm-classification-artifacts";
import {
  runLlmClassificationEvaluation,
} from "@/server/classifications/llm-classification-evaluation";
import type { GoldSetReviewArtifact } from "@/server/classifications/llm-classification-gold-set";
import { LLM_CLASSIFICATION_PROMPT_VERSION } from "@/server/classifications/llm-classification-contract";
import { assertSemanticCatalogCurrent } from "@/server/classifications/classification-semantic-catalog";
import {
  loadSemanticCatalog,
  localArtifactPath,
  parseCliArguments,
  requiredClassificationProvider,
  safeCliError,
} from "./lib/llm-classification-cli";

async function run(): Promise<void> {
  const args = parseCliArguments(process.argv.slice(2));
  const goldSetPath = args.get("gold-set") ?? localArtifactPath("gold-set-reviewed.json");
  const goldSet = readLlmClassificationJson<GoldSetReviewArtifact>(goldSetPath);
  const labeledCount = goldSet.items.filter(
    (item) => item.humanReviewStatus === "REVIEWED" && item.humanExpectedClassificationId
  ).length;
  if (labeledCount === 0) throw new Error("GOLD_SET_NOT_YET_LABELED");
  const catalog = loadSemanticCatalog(args.get("catalog"));
  await assertSemanticCatalogCurrent(db, catalog);
  const result = await runLlmClassificationEvaluation({
    goldSet,
    catalog,
    provider: requiredClassificationProvider(),
    model: env.aiClassificationModel,
    timeoutMs: env.aiRequestTimeoutSeconds * 1_000,
  });
  writeLlmClassificationJson(
    args.get("output") ?? localArtifactPath("evaluation-latest.json"),
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      model: env.aiClassificationModel,
      promptVersion: LLM_CLASSIFICATION_PROMPT_VERSION,
      taxonomyFingerprint: catalog.taxonomyFingerprint,
      semanticCatalogFingerprint: catalog.semanticCatalogFingerprint,
      metrics: result.metrics,
      tokenUsage: result.tokenUsage,
      predictions: result.predictions,
    },
    { private: true }
  );
  console.log(JSON.stringify({ status: result.metrics.status, sampleSize: result.metrics.sampleSize }));
}

run()
  .catch((error: unknown) => {
    console.error(safeCliError(error));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
