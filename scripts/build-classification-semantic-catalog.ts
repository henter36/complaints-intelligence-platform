import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { buildClassificationSemanticCatalog } from "@/server/classifications/classification-semantic-catalog";
import { writeLlmClassificationJson } from "@/server/classifications/llm-classification-artifacts";
import {
  artifactBasename,
  enabledClassificationProvider,
  localArtifactPath,
  parseCliArguments,
  runLlmClassificationCli,
} from "./lib/llm-classification-cli";

async function run(): Promise<void> {
  const args = parseCliArguments(process.argv.slice(2));
  const outputPath = args.get("output") ?? localArtifactPath("semantic-catalog-draft.json");
  const provider = enabledClassificationProvider();
  const catalog = await buildClassificationSemanticCatalog({
    db,
    model: env.aiClassificationModel,
    provider,
    timeoutMs: env.aiRequestTimeoutSeconds * 1_000,
  });
  writeLlmClassificationJson(outputPath, catalog);
  console.log(JSON.stringify({
    status: catalog.status,
    generationStatus: provider ? "GENERATED_BY_LLM" : "PENDING_LLM_ENRICHMENT",
    categoryCount: catalog.categoryCount,
    classificationCount: catalog.classificationCount,
    output: artifactBasename(outputPath),
  }));
}

void runLlmClassificationCli({
  run,
  disconnect: () => db.$disconnect(),
});
