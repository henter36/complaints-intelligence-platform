import { Prisma } from "@prisma/client";
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
  loadCurrentTaxonomy,
  type RestructureDb,
} from "./classification-taxonomy-manifest";

type VerificationInvariant = { code: string; ok: boolean; detail?: string };

type VerificationRun = NonNullable<
  Awaited<ReturnType<RestructureDb["classificationTaxonomyRestructureRun"]["findUnique"]>>
>;

function requireVerifyInputs(input: {
  runId?: string;
  proposalPath?: string;
  mappingPath?: string;
}): { runId: string; proposalPath: string; mappingPath: string } {
  if (!input.runId) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.RUN_ID_REQUIRED,
      "verify يتطلب --run-id"
    );
  }
  if (!input.proposalPath) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.PROPOSAL_REQUIRED,
      "verify يتطلب --proposal"
    );
  }
  if (!input.mappingPath) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.MAPPING_REQUIRED,
      "verify يتطلب --mapping"
    );
  }
  return {
    runId: input.runId,
    proposalPath: input.proposalPath,
    mappingPath: input.mappingPath,
  };
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

function loadExpectedTaxonomyCounts(proposalPath: string, mappingPath: string): {
  expectedCategoryCount: number;
  expectedClassificationCount: number;
  proposal: ClassificationTaxonomyProposal;
} {
  const proposal = loadAndValidateProposal(proposalPath, mappingPath).proposal;
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
      ok: activeCategoryCount === expectedCategoryCount,
      detail: String(activeCategoryCount),
    },
    {
      code: "ACTIVE_CLASSIFICATION_COUNT",
      ok: activeClassificationCount === expectedClassificationCount,
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

function verifyKeywordInvariants(
  activeClassifications: Array<{ id: string; keywords: unknown }>
): VerificationInvariant[] {
  const keywordOwner = new Map<string, string>();
  let keywordOk = true;
  let parseFailureCount = 0;
  for (const cls of activeClassifications) {
    let kws: string[] = [];
    try {
      kws = parseClassificationKeywords(cls.keywords ?? []);
    } catch {
      parseFailureCount += 1;
      keywordOk = false;
      continue;
    }
    for (const kw of kws) {
      const n = normalizeClassificationKeyword(kw);
      if (!n) continue;
      if (keywordOwner.has(n) && keywordOwner.get(n) !== cls.id) keywordOk = false;
      keywordOwner.set(n, cls.id);
    }
  }
  return [
    {
      code: "KEYWORDS_PARSEABLE",
      ok: parseFailureCount === 0,
      detail: String(parseFailureCount),
    },
    { code: "UNIQUE_KEYWORDS", ok: keywordOk && parseFailureCount === 0 },
  ];
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

async function countQuery(db: RestructureDb, query: Prisma.Sql): Promise<number> {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>(query);
  return Number(rows[0]?.count ?? 0);
}

async function countClassifiedComplaints(db: RestructureDb): Promise<number> {
  return db.complaint.count({
    where: { isDeleted: false, classificationId: { not: null } },
  });
}

async function countUnclassifiedComplaints(db: RestructureDb): Promise<number> {
  return db.complaint.count({ where: { isDeleted: false, classificationId: null } });
}

async function countCategoryClassificationMismatches(db: RestructureDb): Promise<number> {
  return countQuery(
    db,
    Prisma.sql`
      SELECT COUNT(*) AS count
      FROM "Complaint" AS complaint
      LEFT JOIN "Classification" AS classification
        ON classification.id = complaint.classificationId
      WHERE complaint.isDeleted = 0
        AND complaint.classificationId IS NOT NULL
        AND (
          classification.id IS NULL
          OR complaint.categoryId IS NULL
          OR complaint.categoryId <> classification.categoryId
        )
    `
  );
}

async function countInactiveClassificationReferences(db: RestructureDb): Promise<number> {
  return countQuery(
    db,
    Prisma.sql`
      SELECT COUNT(*) AS count
      FROM "Complaint" AS complaint
      INNER JOIN "Classification" AS classification
        ON classification.id = complaint.classificationId
      WHERE complaint.isDeleted = 0
        AND complaint.classificationId IS NOT NULL
        AND (classification.isActive = 0 OR classification.isDeleted = 1)
    `
  );
}

async function verifyComplaintCategoryConsistency(db: RestructureDb): Promise<{
  invariant: VerificationInvariant;
  classifiedCount: number;
  mismatchedCount: number;
}> {
  const classifiedCount = await countClassifiedComplaints(db);
  const mismatchedCount = await countCategoryClassificationMismatches(db);
  return {
    classifiedCount,
    mismatchedCount,
    invariant: {
      code: "CATEGORY_CLASSIFICATION_CONSISTENCY",
      ok: mismatchedCount === 0,
      detail: `classified=${classifiedCount},mismatched=${mismatchedCount}`,
    },
  };
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

async function resolveOriginalApplyRun(
  db: RestructureDb,
  run: VerificationRun
): Promise<VerificationRun> {
  if (run.operation === RESTRUCTURE_OPERATIONS.ROLLBACK && run.rollbackOfRunId) {
    const original = await db.classificationTaxonomyRestructureRun.findUnique({
      where: { id: run.rollbackOfRunId },
    });
    if (!original) {
      throw new TaxonomyRestructureError(
        RESTRUCTURE_ERROR_CODES.RUN_NOT_FOUND,
        "تشغيل Apply الأصلي غير موجود"
      );
    }
    return original;
  }
  return run;
}

async function verifyRollbackOutcome(
  db: RestructureDb,
  run: VerificationRun
): Promise<{
  ok: boolean;
  invariants: VerificationInvariant[];
  activeCategoryCount: number;
  activeClassificationCount: number;
  unclassifiedCount: number;
  classifiedCount: number;
}> {
  const original = await resolveOriginalApplyRun(db, run);
  const live = await loadCurrentTaxonomy(db);
  const activeCategories = live.categories.filter((c) => c.isActive);
  const activeClassifications = live.classifications.filter((c) => c.isActive);
  const unclassifiedCount = await countUnclassifiedComplaints(db);
  const consistency = await verifyComplaintCategoryConsistency(db);
  const inactiveRefs = await countInactiveClassificationReferences(db);

  const rollbackRunId =
    run.operation === RESTRUCTURE_OPERATIONS.ROLLBACK ? run.id : null;
  const itemWhere = rollbackRunId
    ? { runId: rollbackRunId }
    : { runId: original.id, result: { in: ["ROLLED_BACK", "ROLLBACK_SKIPPED"] } };
  const rollbackItems = await db.classificationTaxonomyRestructureItem.findMany({
    where: itemWhere,
    select: { result: true },
  });
  const rolledBackCount = rollbackItems.filter((i) => i.result === "ROLLED_BACK").length;
  const skippedCount = rollbackItems.filter((i) => i.result === "ROLLBACK_SKIPPED").length;
  const statusForRules =
    run.operation === RESTRUCTURE_OPERATIONS.ROLLBACK ? run.status : original.status;

  const fingerprintMatch = live.fingerprint === original.currentTaxonomyFingerprint;
  const invariants: VerificationInvariant[] = [
    {
      code: "ROLLBACK_TERMINAL_STATE_PRESERVED",
      ok: statusForRules !== RESTRUCTURE_RUN_STATUSES.ROLLING_BACK,
      detail: statusForRules,
    },
    {
      code: "ROLLBACK_TARGET_FINGERPRINT_MATCH",
      ok:
        statusForRules === RESTRUCTURE_RUN_STATUSES.PARTIALLY_ROLLED_BACK
          ? true
          : fingerprintMatch,
      detail: fingerprintMatch ? "match" : "mismatch",
    },
    {
      code: "ROLLBACK_ITEM_COUNTS_CONSISTENT",
      ok: rolledBackCount + skippedCount === rollbackItems.length,
      detail: `rolledBack=${rolledBackCount},skipped=${skippedCount}`,
    },
    {
      code: "ROLLBACK_NO_SKIPS_FOR_FULL_STATUS",
      ok:
        statusForRules !== RESTRUCTURE_RUN_STATUSES.ROLLED_BACK || skippedCount === 0,
      detail: String(skippedCount),
    },
    {
      code: "ROLLBACK_HAS_SKIPS_FOR_PARTIAL_STATUS",
      ok:
        statusForRules !== RESTRUCTURE_RUN_STATUSES.PARTIALLY_ROLLED_BACK ||
        skippedCount > 0,
      detail: String(skippedCount),
    },
    consistency.invariant,
    {
      code: "CLASSIFIED_COMPLAINTS_REFERENCE_ACTIVE_CLASSIFICATIONS",
      ok: inactiveRefs === 0,
      detail: String(inactiveRefs),
    },
  ];

  const ok =
    statusForRules === RESTRUCTURE_RUN_STATUSES.ROLLED_BACK &&
    invariants.every((i) => i.ok);

  return {
    ok,
    invariants,
    activeCategoryCount: activeCategories.length,
    activeClassificationCount: activeClassifications.length,
    unclassifiedCount,
    classifiedCount: consistency.classifiedCount,
  };
}

export async function verifyTaxonomyRestructure(
  db: RestructureDb,
  input: { runId: string; proposalPath?: string; mappingPath?: string }
) {
  const required = requireVerifyInputs(input);
  const run = await loadRestructureVerificationRun(db, required.runId);

  if (isRollbackTerminalOrActive(run)) {
    const measured = await verifyRollbackOutcome(db, run);
    const status = await persistVerificationOutcome({
      db,
      run,
      ok: measured.ok,
      mode: "rollback",
    });
    await writeAuditLog(db, {
      action: "CLASSIFICATION_TAXONOMY_RESTRUCTURE_VERIFIED",
      entityType: "ClassificationTaxonomyRestructureRun",
      entityId: run.id,
      actor: AUDIT_ACTOR_SYSTEM,
      metadata: { runId: run.id, verificationMode: "rollback", status, ok: measured.ok },
    });
    return buildVerificationResult({
      runId: run.id,
      ok: measured.ok,
      invariants: measured.invariants,
      activeCategoryCount: measured.activeCategoryCount,
      activeClassificationCount: measured.activeClassificationCount,
      unclassifiedCount: measured.unclassifiedCount,
      classifiedCount: measured.classifiedCount,
      status,
    });
  }

  const { expectedCategoryCount, expectedClassificationCount, proposal } =
    loadExpectedTaxonomyCounts(required.proposalPath, required.mappingPath);
  const { activeCategories, activeClassifications } =
    await loadActiveTaxonomyForVerification(db);
  const live = await loadCurrentTaxonomy(db);
  const consistency = await verifyComplaintCategoryConsistency(db);
  const unclassifiedCount = await countUnclassifiedComplaints(db);
  const inactiveRefs = await countInactiveClassificationReferences(db);

  const invariants: VerificationInvariant[] = [
    ...buildCountInvariants(
      activeCategories.length,
      activeClassifications.length,
      expectedCategoryCount,
      expectedClassificationCount
    ),
    verifyCategoryClassificationNames(activeClassifications),
    ...verifyKeywordInvariants(activeClassifications),
    verifySourceDetailMappings(proposal, buildResolverCandidates(activeClassifications)),
    consistency.invariant,
    {
      code: "TARGET_TAXONOMY_FINGERPRINT_MATCH",
      ok: live.fingerprint === run.targetTaxonomyFingerprint,
      detail: live.fingerprint === run.targetTaxonomyFingerprint ? "match" : "mismatch",
    },
    {
      code: "CLASSIFIED_COMPLAINTS_REFERENCE_ACTIVE_CLASSIFICATIONS",
      ok: inactiveRefs === 0,
      detail: String(inactiveRefs),
    },
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
