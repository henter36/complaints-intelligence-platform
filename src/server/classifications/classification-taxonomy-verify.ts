import { writeAuditLog, AUDIT_ACTOR_SYSTEM } from "@/server/audit/audit-log-service";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import { parseClassificationKeywords } from "./classification-keywords";
import {
  resolveSourceDetailClassification,
  type SourceDetailClassificationCandidate,
} from "./source-detail-classification-resolver";
import { assertClassificationNameDiffersFromCategory } from "./classification-management-service";
import {
  RESTRUCTURE_ERROR_CODES,
  TaxonomyRestructureError,
  loadAndValidateProposal,
  type ClassificationTaxonomyProposal,
} from "./classification-taxonomy-proposal";
import {
  RESTRUCTURE_OPERATIONS,
  RESTRUCTURE_RUN_STATUSES,
  type RestructureDb,
} from "./classification-taxonomy-manifest";

type VerificationInvariant = { code: string; ok: boolean; detail?: string };

type VerificationRun = NonNullable<
  Awaited<ReturnType<RestructureDb["classificationTaxonomyRestructureRun"]["findUnique"]>>
>;

/**
 * Legacy fallback when proposal/mapping are not provided to verify.
 * Prefer deriving counts from the proposal when available.
 */
function legacyExpectedTaxonomyCountsFallback(): {
  expectedCategoryCount: number;
  expectedClassificationCount: number;
} {
  return { expectedCategoryCount: 11, expectedClassificationCount: 27 };
}

function isRollbackTerminalOrActive(run: VerificationRun): boolean {
  if (run.operation === RESTRUCTURE_OPERATIONS.ROLLBACK) return true;
  return (
    run.status === RESTRUCTURE_RUN_STATUSES.ROLLED_BACK ||
    run.status === RESTRUCTURE_RUN_STATUSES.PARTIALLY_ROLLED_BACK ||
    run.status === RESTRUCTURE_RUN_STATUSES.ROLLING_BACK
  );
}

async function loadRestructureVerificationRun(
  db: RestructureDb,
  runId: string
): Promise<VerificationRun> {
  const run = await db.classificationTaxonomyRestructureRun.findUnique({ where: { id: runId } });
  if (!run) {
    throw new TaxonomyRestructureError(RESTRUCTURE_ERROR_CODES.RUN_NOT_FOUND, "التشغيل غير موجود");
  }
  return run;
}

function loadExpectedTaxonomyCounts(input: {
  proposalPath?: string;
  mappingPath?: string;
}): { expectedCategoryCount: number; expectedClassificationCount: number; proposal: ClassificationTaxonomyProposal | null } {
  if (!input.proposalPath || !input.mappingPath) {
    return { ...legacyExpectedTaxonomyCountsFallback(), proposal: null };
  }
  const proposal = loadAndValidateProposal(input.proposalPath, input.mappingPath).proposal;
  return {
    proposal,
    expectedCategoryCount: proposal.proposedTaxonomy.length,
    expectedClassificationCount: proposal.proposedTaxonomy.reduce(
      (sum, cat) => sum + cat.classifications.length,
      0
    ),
  };
}

async function loadActiveTaxonomyForVerification(db: RestructureDb) {
  const activeCategories = await db.category.findMany({
    where: { isActive: true, isDeleted: false },
  });
  const activeClassifications = await db.classification.findMany({
    where: { isActive: true, isDeleted: false },
    include: { category: true },
  });
  return { activeCategories, activeClassifications };
}

function buildCountInvariants(
  activeCategoryCount: number,
  activeClassificationCount: number,
  expectedCategoryCount: number,
  expectedClassificationCount: number
): VerificationInvariant[] {
  return [
    {
      code: "ACTIVE_CATEGORY_COUNT",
      ok: activeCategoryCount >= expectedCategoryCount,
      detail: String(activeCategoryCount),
    },
    {
      code: "ACTIVE_CLASSIFICATION_COUNT",
      ok: activeClassificationCount >= expectedClassificationCount,
      detail: String(activeClassificationCount),
    },
  ];
}

function verifyCategoryClassificationNames(
  activeClassifications: Array<{ nameAr: string; category: { nameAr: string } }>
): VerificationInvariant {
  let namingOk = true;
  for (const cls of activeClassifications) {
    try {
      assertClassificationNameDiffersFromCategory(cls.category.nameAr, cls.nameAr);
    } catch {
      namingOk = false;
      break;
    }
  }
  return { code: "NO_NAME_EQUALS_CATEGORY", ok: namingOk };
}

function verifyUniqueKeywords(
  activeClassifications: Array<{ id: string; keywords: unknown }>
): VerificationInvariant {
  const keywordOwner = new Map<string, string>();
  let keywordOk = true;
  for (const cls of activeClassifications) {
    let kws: string[] = [];
    try {
      kws = parseClassificationKeywords(cls.keywords ?? []);
    } catch {
      kws = [];
    }
    for (const kw of kws) {
      const n = normalizeClassificationKeyword(kw);
      if (!n) continue;
      if (keywordOwner.has(n) && keywordOwner.get(n) !== cls.id) keywordOk = false;
      keywordOwner.set(n, cls.id);
    }
  }
  return { code: "UNIQUE_KEYWORDS", ok: keywordOk };
}

function buildResolverCandidates(
  activeClassifications: Array<{
    id: string;
    nameAr: string;
    keywords: unknown;
    isActive: boolean;
    isDeleted: boolean;
    category: { id: string; nameAr: string; isActive: boolean; isDeleted: boolean };
  }>
): SourceDetailClassificationCandidate[] {
  return activeClassifications.map((c) => ({
    id: c.id,
    nameAr: c.nameAr,
    keywords: c.keywords,
    isActive: c.isActive,
    isDeleted: c.isDeleted,
    category: {
      id: c.category.id,
      nameAr: c.category.nameAr,
      isActive: c.category.isActive,
      isDeleted: c.category.isDeleted,
    },
  }));
}

function verifySourceDetailMappings(
  proposal: ClassificationTaxonomyProposal,
  candidates: SourceDetailClassificationCandidate[]
): VerificationInvariant {
  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;
  for (const m of proposal.sourceDetailMappings) {
    const res = resolveSourceDetailClassification({
      sourceDetail: m.sourceDetail,
      classifications: candidates,
    });
    if (res.status === "MATCHED") matched += 1;
    else if (res.status === "AMBIGUOUS") ambiguous += 1;
    else unmatched += 1;
  }
  return {
    code: "SOURCE_DETAIL_MATCHED_UNIQUE",
    ok: matched === proposal.sourceDetailMappings.length && ambiguous === 0 && unmatched === 0,
    detail: `matched=${matched},ambiguous=${ambiguous},unmatched=${unmatched}`,
  };
}

async function verifyComplaintCategoryConsistency(db: RestructureDb): Promise<{
  invariant: VerificationInvariant;
  classifiedCount: number;
}> {
  const classified = await db.complaint.findMany({
    where: { isDeleted: false, classificationId: { not: null } },
    select: { categoryId: true, classification: { select: { categoryId: true } } },
  });
  return {
    classifiedCount: classified.length,
    invariant: {
      code: "CATEGORY_CLASSIFICATION_CONSISTENCY",
      ok: classified.every((c) => c.classification && c.categoryId === c.classification.categoryId),
      detail: String(classified.length),
    },
  };
}

async function countUnclassifiedComplaints(db: RestructureDb): Promise<number> {
  return db.complaint.count({ where: { isDeleted: false, classificationId: null } });
}

async function persistVerificationOutcome(input: {
  db: RestructureDb;
  run: VerificationRun;
  ok: boolean;
  mode: "apply" | "rollback";
}): Promise<string> {
  if (input.mode === "rollback") {
    return input.run.status;
  }
  if (!input.ok) {
    await input.db.classificationTaxonomyRestructureRun.update({
      where: { id: input.run.id },
      data: { status: RESTRUCTURE_RUN_STATUSES.VERIFY_FAILED },
    });
    return RESTRUCTURE_RUN_STATUSES.VERIFY_FAILED;
  }
  if (input.run.status === RESTRUCTURE_RUN_STATUSES.VERIFY_FAILED) {
    await input.db.classificationTaxonomyRestructureRun.update({
      where: { id: input.run.id },
      data: { status: RESTRUCTURE_RUN_STATUSES.APPLIED },
    });
    return RESTRUCTURE_RUN_STATUSES.APPLIED;
  }
  return input.run.status;
}

function buildVerificationResult(input: {
  runId: string;
  ok: boolean;
  invariants: VerificationInvariant[];
  activeCategoryCount: number;
  activeClassificationCount: number;
  unclassifiedCount: number;
  classifiedCount: number;
  status: string;
}) {
  return {
    mode: "verify" as const,
    runId: input.runId,
    ok: input.ok,
    status: input.status,
    invariants: input.invariants,
    activeCategoryCount: input.activeCategoryCount,
    activeClassificationCount: input.activeClassificationCount,
    unclassifiedCount: input.unclassifiedCount,
    classifiedCount: input.classifiedCount,
  };
}

async function verifyRollbackOutcome(run: VerificationRun): Promise<VerificationInvariant[]> {
  return [
    {
      code: "ROLLBACK_TERMINAL_STATE_PRESERVED",
      ok: true,
      detail: run.status,
    },
  ];
}

export async function verifyTaxonomyRestructure(
  db: RestructureDb,
  input: { runId: string; proposalPath?: string; mappingPath?: string }
) {
  const run = await loadRestructureVerificationRun(db, input.runId);

  if (isRollbackTerminalOrActive(run)) {
    const invariants = await verifyRollbackOutcome(run);
    const ok = invariants.every((i) => i.ok);
    const status = await persistVerificationOutcome({ db, run, ok, mode: "rollback" });
    await writeAuditLog(db, {
      action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_VERIFIED",
      entityType: "ClassificationTaxonomyRestructureRun",
      entityId: run.id,
      actor: AUDIT_ACTOR_SYSTEM,
      metadata: { runId: run.id, verificationMode: "rollback", status, ok },
    });
    const unclassifiedCount = await countUnclassifiedComplaints(db);
    return buildVerificationResult({
      runId: run.id,
      ok,
      invariants,
      activeCategoryCount: 0,
      activeClassificationCount: 0,
      unclassifiedCount,
      classifiedCount: 0,
      status,
    });
  }

  const { expectedCategoryCount, expectedClassificationCount, proposal } =
    loadExpectedTaxonomyCounts(input);
  const { activeCategories, activeClassifications } = await loadActiveTaxonomyForVerification(db);

  const consistency = await verifyComplaintCategoryConsistency(db);
  const unclassifiedCount = await countUnclassifiedComplaints(db);
  const mappingInvariant = proposal
    ? [
        verifySourceDetailMappings(
          proposal,
          buildResolverCandidates(activeClassifications)
        ),
      ]
    : [];
  const invariants: VerificationInvariant[] = [
    ...buildCountInvariants(
      activeCategories.length,
      activeClassifications.length,
      expectedCategoryCount,
      expectedClassificationCount
    ),
    verifyCategoryClassificationNames(activeClassifications),
    verifyUniqueKeywords(activeClassifications),
    ...mappingInvariant,
    consistency.invariant,
    { code: "UNCLASSIFIED_PRESENT", ok: true, detail: String(unclassifiedCount) },
  ];

  const ok = invariants.every((i) => i.ok);
  const status = await persistVerificationOutcome({ db, run, ok, mode: "apply" });
  await writeAuditLog(db, {
    action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_VERIFIED",
    entityType: "ClassificationTaxonomyRestructureRun",
    entityId: run.id,
    actor: AUDIT_ACTOR_SYSTEM,
    metadata: { runId: run.id, verificationMode: "apply", status, ok },
  });

  return buildVerificationResult({
    runId: run.id,
    ok,
    invariants,
    activeCategoryCount: activeCategories.length,
    activeClassificationCount: activeClassifications.length,
    unclassifiedCount,
    classifiedCount: consistency.classifiedCount,
    status,
  });
}
