import { db } from "@/lib/db";
import { prepareClassificationGoldSet } from "@/server/classifications/llm-classification-gold-set";
import { assertSemanticCatalogCurrent } from "@/server/classifications/classification-semantic-catalog";
import { writeLlmClassificationJson } from "@/server/classifications/llm-classification-artifacts";
import {
  loadSemanticCatalog,
  localArtifactPath,
  parseCliArguments,
  positiveIntegerArgument,
  runLlmClassificationCli,
} from "./lib/llm-classification-cli";

async function run(): Promise<void> {
  const args = parseCliArguments(process.argv.slice(2));
  const size = positiveIntegerArgument(args, "size", 400);
  if (size < 300 || size > 500) throw new Error("GOLD_SET_SIZE_MUST_BE_300_TO_500");
  const catalog = loadSemanticCatalog(args.get("catalog"));
  await assertSemanticCatalogCurrent(db, catalog);
  const result = await prepareClassificationGoldSet({ db, catalog, size });
  writeLlmClassificationJson(
    args.get("output") ?? localArtifactPath("gold-set-review.json"),
    result.review,
    { private: true }
  );
  writeLlmClassificationJson(
    args.get("private-map") ?? localArtifactPath("private-gold-map.json"),
    result.privateMap,
    { private: true }
  );
  console.log(JSON.stringify({
    status: result.review.status,
    selectedCount: result.review.selectedCount,
    developmentCount: result.review.developmentCount,
    holdoutCount: result.review.holdoutCount,
  }));
}

void runLlmClassificationCli({
  run,
  disconnect: () => db.$disconnect(),
});
