/**
 * Public facade for governed classification taxonomy restructure.
 * Implementation is split across plan/apply/verify/rollback/manifest modules.
 */
import { resolve } from "node:path";
import {
  buildConfirmationToken,
  loadAndValidateProposal,
} from "./classification-taxonomy-proposal";
import {
  computeManifestHash,
  countPlanChanges,
  writeManifestAtomically,
  type RestructureDb,
  type RestructureManifest,
} from "./classification-taxonomy-manifest";
import { buildRestructurePlan } from "./classification-taxonomy-plan";

export * from "./classification-taxonomy-proposal";
export {
  RESTRUCTURE_OPERATIONS,
  RESTRUCTURE_RUN_STATUSES,
  computeTaxonomyFingerprint,
  computeTaxonomyShapeFingerprint,
  loadCurrentTaxonomy,
  computeManifestHash,
  writeManifestAtomically,
  readAndValidateManifest,
  emptyPlan,
  countPlanChanges,
  createRestructureItemSequence,
  type RestructureDb,
  type PlanChange,
  type RestructurePlan,
  type RestructureManifest,
  type LoadedCategory,
  type LoadedClassification,
  type RestructureItemSequence,
} from "./classification-taxonomy-manifest";
export { buildRestructurePlan, assertPlanIsApplicable } from "./classification-taxonomy-plan";
export { applyTaxonomyRestructure } from "./classification-taxonomy-apply";
export { verifyTaxonomyRestructure } from "./classification-taxonomy-verify";
export { rollbackTaxonomyRestructure } from "./classification-taxonomy-rollback";
export { rollbackExitCode } from "./restructure-cli-runtime";

export async function previewTaxonomyRestructure(
  db: RestructureDb,
  input: {
    proposalPath: string;
    mappingPath: string;
    manifestPath: string;
    overwrite?: boolean;
  }
) {
  const { proposal, proposalHash, mappingHash } = loadAndValidateProposal(
    input.proposalPath,
    input.mappingPath
  );
  const { plan, currentFingerprint, targetFingerprint } = await buildRestructurePlan(db, proposal);
  const changeCount = countPlanChanges(plan);
  const withoutHash: Omit<RestructureManifest, "manifestHash" | "confirmationToken"> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    proposalHash,
    mappingHash,
    currentTaxonomyFingerprint: currentFingerprint,
    targetTaxonomyFingerprint: targetFingerprint,
    plan,
    totals: {
      changeCount,
      categoriesToCreate: plan.categoriesToCreate.length,
      categoriesToRename: plan.categoriesToRename.length,
      categoriesToReactivate: plan.categoriesToReactivate.length,
      classificationsToCreate: plan.classificationsToCreate.length,
      classificationsToRename: plan.classificationsToRename.length,
      classificationsToMove: plan.classificationsToMove.length,
      classificationsToReactivate: plan.classificationsToReactivate.length,
      classificationsToDeactivate: plan.classificationsToDeactivate.length,
      keywordChangeCount: plan.keywordsToAdd.length + plan.keywordsToRemove.length,
      legacyComplaintConsistencyUpdateCount:
        plan.complaintsRequiringCategoryConsistencyUpdate.length,
      unclassifiedComplaintsUntouched: true,
    },
  };
  const manifestHash = computeManifestHash(withoutHash);
  const confirmationToken = buildConfirmationToken(manifestHash, changeCount);
  const manifest: RestructureManifest = { ...withoutHash, manifestHash, confirmationToken };
  await writeManifestAtomically(input.manifestPath, manifest, input.overwrite === true);
  return {
    mode: "dry-run" as const,
    manifestPath: resolve(input.manifestPath),
    manifestHash,
    currentTaxonomyFingerprint: currentFingerprint,
    targetTaxonomyFingerprint: targetFingerprint,
    confirmationToken,
    plan,
    planSummary: {
      categoriesToCreate: plan.categoriesToCreate.map((c) => c.targetName),
      categoriesToRename: plan.categoriesToRename.map((c) => `${c.currentName} → ${c.targetName}`),
      categoriesToReactivate: plan.categoriesToReactivate.map((c) => c.targetName),
      classificationsToCreate: plan.classificationsToCreate.map(
        (c) => `${c.targetCategory} / ${c.targetName}`
      ),
      classificationsToMove: plan.classificationsToMove.map(
        (c) => `${c.currentCategory}/${c.currentName} → ${c.targetCategory}/${c.targetName}`
      ),
      classificationsToRename: plan.classificationsToRename.map(
        (c) => `${c.currentName} → ${c.targetName}`
      ),
      classificationsToReactivate: plan.classificationsToReactivate.map(
        (c) => `${c.targetCategory} / ${c.targetName}`
      ),
      keywordChanges: plan.keywordsToAdd.length + plan.keywordsToRemove.length,
      legacyComplaintsAffected: plan.legacyComplaintsAffected.length,
      consistencyUpdates: plan.complaintsRequiringCategoryConsistencyUpdate.length,
      namingConflicts: plan.namingConflicts,
      deactivations: {
        categories: plan.categoriesToDeactivate.map((c) => c.currentName),
        classifications: plan.classificationsToDeactivate.map((c) => c.currentName),
      },
    },
    totals: withoutHash.totals,
  };
}
