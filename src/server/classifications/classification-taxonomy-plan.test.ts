import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  computeTaxonomyShapeFingerprint,
  emptyPlan,
} from "./classification-taxonomy-manifest";
import {
  assertPlanIsApplicable,
  buildPlanChange,
  createPlanningContext,
  ensureProposedCategories,
  ensureProposedClassifications,
  indexProposedTaxonomy,
  processEntityMigrations,
  resolveExistingCategory,
  resolveExistingClassification,
} from "./classification-taxonomy-plan";
import { loadAndValidateProposal, RESTRUCTURE_ERROR_CODES } from "./classification-taxonomy-proposal";

const FIXTURE_DIR = join(process.cwd(), "src/server/classifications/__fixtures__");
const PROPOSAL = join(FIXTURE_DIR, "mini-proposed-taxonomy.json");
const MAPPING = join(FIXTURE_DIR, "mini-source-detail-mapping.csv");

describe("taxonomy shape fingerprint", () => {
  it("ignores cuid differences and reacts to name/keyword/category changes", () => {
    const cats = [
      { nameAr: "الرعاية الصحية", isActive: true, isDeleted: false },
      { nameAr: "الخدمات", isActive: true, isDeleted: false },
    ];
    const clsA = [
      {
        nameAr: "المواعيد",
        categoryName: "الرعاية الصحية",
        keywords: ["عدم خروجه لموعد"],
        isActive: true,
        isDeleted: false,
      },
    ];
    const clsB = [
      {
        nameAr: "المواعيد",
        categoryName: "الرعاية الصحية",
        keywords: ["عدم خروجه لموعد"],
        isActive: true,
        isDeleted: false,
      },
    ];
    expect(computeTaxonomyShapeFingerprint(cats, clsA)).toBe(
      computeTaxonomyShapeFingerprint(cats, clsB)
    );
    expect(
      computeTaxonomyShapeFingerprint(cats, [
        { ...clsA[0]!, nameAr: "مواعيد مختلفة" },
      ])
    ).not.toBe(computeTaxonomyShapeFingerprint(cats, clsA));
    expect(
      computeTaxonomyShapeFingerprint(cats, [
        { ...clsA[0]!, categoryName: "الخدمات" },
      ])
    ).not.toBe(computeTaxonomyShapeFingerprint(cats, clsA));
    expect(
      computeTaxonomyShapeFingerprint(cats, [
        { ...clsA[0]!, keywords: ["كلمة أخرى"] },
      ])
    ).not.toBe(computeTaxonomyShapeFingerprint(cats, clsA));
  });
});

describe("classification resolution ambiguity", () => {
  it("returns AMBIGUOUS when the same name exists under two categories", () => {
    const proposal = loadAndValidateProposal(PROPOSAL, MAPPING).proposal;
    const current = {
      categories: [
        {
          id: "c1",
          nameAr: "فئة أ",
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
        {
          id: "c2",
          nameAr: "فئة ب",
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
      ],
      classifications: [
        {
          id: "x1",
          nameAr: "مشترك",
          categoryId: "c1",
          categoryName: "فئة أ",
          keywords: [],
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
        {
          id: "x2",
          nameAr: "مشترك",
          categoryId: "c2",
          categoryName: "فئة ب",
          keywords: [],
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
      ],
      fingerprint: "f",
    };
    const ctx = createPlanningContext(current, proposal);
    expect(resolveExistingClassification(ctx, "", "مشترك").status).toBe("AMBIGUOUS");
    expect(resolveExistingClassification(ctx, "", "مشترك", "فئة أ").status).toBe("FOUND");
    expect(resolveExistingClassification(ctx, "x2", "مشترك").status).toBe("FOUND");
  });

  it("blocks apply when plan has naming conflicts", () => {
    const plan = emptyPlan();
    plan.namingConflicts.push("ambiguous");
    expect(() => assertPlanIsApplicable(plan)).toThrowError(
      expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.PLAN_NOT_APPLICABLE })
    );
  });
});

describe("inactive category reuse and reactivation", () => {
  it("plans REACTIVATE instead of CREATE for inactive matching category", () => {
    const proposal = loadAndValidateProposal(PROPOSAL, MAPPING).proposal;
    const inactiveId = "inactive_data_quality";
    const current = {
      categories: [
        {
          id: inactiveId,
          nameAr: "بيانات غير محددة",
          isActive: false,
          isDeleted: false,
          complaintCount: 0,
        },
      ],
      classifications: [],
      fingerprint: "f",
    };
    const ctx = createPlanningContext(current, proposal);
    ensureProposedCategories(ctx);
    expect(ctx.plan.categoriesToCreate.some((c) => c.targetName === "بيانات غير محددة")).toBe(
      false
    );
    expect(ctx.plan.categoriesToReactivate).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentId: inactiveId,
          targetName: "بيانات غير محددة",
          action: "REACTIVATE",
        }),
      ])
    );
    expect(ctx.plan.finalCategoryTargets["بيانات غير محددة"]?.reuseId).toBe(inactiveId);
  });

  it("keeps active matching category as KEEP and creates only missing ones", () => {
    const proposal = loadAndValidateProposal(PROPOSAL, MAPPING).proposal;
    const current = {
      categories: [
        {
          id: "active_health",
          nameAr: "الرعاية الصحية",
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
      ],
      classifications: [],
      fingerprint: "f",
    };
    const ctx = createPlanningContext(current, proposal);
    ensureProposedCategories(ctx);
    expect(ctx.plan.categoriesToReactivate).toHaveLength(0);
    expect(ctx.plan.categoriesToKeep.some((c) => c.currentId === "active_health")).toBe(true);
    expect(ctx.plan.categoriesToCreate.some((c) => c.targetName === "الرعاية الصحية")).toBe(false);
    expect(ctx.plan.categoriesToCreate.some((c) => c.targetName === "بيانات غير محددة")).toBe(true);
  });

  it("prefers exact name over normalized peers", () => {
    const proposal = loadAndValidateProposal(PROPOSAL, MAPPING).proposal;
    const current = {
      categories: [
        {
          id: "a1",
          nameAr: "بيانات  غير محددة",
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
        {
          id: "a2",
          nameAr: "بيانات غير محددة",
          isActive: false,
          isDeleted: false,
          complaintCount: 0,
        },
      ],
      classifications: [],
      fingerprint: "f",
    };
    const ctx = createPlanningContext(current, proposal);
    const resolution = resolveExistingCategory(ctx, "", "بيانات غير محددة");
    expect(resolution.status).toBe("FOUND");
    if (resolution.status === "FOUND") {
      expect(resolution.category.id).toBe("a2");
    }
  });

  it("returns AMBIGUOUS when multiple categories match only after normalization", () => {
    const proposal = loadAndValidateProposal(PROPOSAL, MAPPING).proposal;
    const current = {
      categories: [
        {
          id: "n1",
          nameAr: "بيانات  غير محددة",
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
        {
          id: "n2",
          nameAr: "بيانات غير  محددة",
          isActive: false,
          isDeleted: false,
          complaintCount: 0,
        },
      ],
      classifications: [],
      fingerprint: "f",
    };
    const ctx = createPlanningContext(current, proposal);
    const resolution = resolveExistingCategory(ctx, "", "بيانات غير محددة");
    expect(resolution.status).toBe("AMBIGUOUS");
    if (resolution.status === "AMBIGUOUS") {
      expect(resolution.matches).toHaveLength(2);
    }
  });
});

describe("ensureProposedClassifications planning", () => {
  function baseCategory(id: string, nameAr: string) {
    return { id, nameAr, isActive: true, isDeleted: false, complaintCount: 0 };
  }

  function baseClassification(input: {
    id: string;
    nameAr: string;
    categoryId: string;
    categoryName: string;
    isActive?: boolean;
  }) {
    return {
      id: input.id,
      nameAr: input.nameAr,
      categoryId: input.categoryId,
      categoryName: input.categoryName,
      keywords: [],
      isActive: input.isActive ?? true,
      isDeleted: false,
      complaintCount: 0,
    };
  }

  it("reuses preexisting classificationReuseByKey without searching again", () => {
    const proposal = loadAndValidateProposal(PROPOSAL, MAPPING).proposal;
    const ctx = createPlanningContext(
      { categories: [], classifications: [], fingerprint: "f" },
      proposal
    );
    ctx.classificationReuseByKey.set("OTHER_REVIEW", "preexisting-id");
    ensureProposedClassifications(ctx);
    expect(ctx.plan.finalClassificationTargets.OTHER_REVIEW?.reuseId).toBe("preexisting-id");
    expect(ctx.plan.classificationsToCreate.some((c) => c.classificationKey === "OTHER_REVIEW")).toBe(
      false
    );
    expect(ctx.plan.classificationsToKeep.some((c) => c.classificationKey === "OTHER_REVIEW")).toBe(
      false
    );
  });

  it("keeps active matches, reactivates inactive matches, and creates missing ones", () => {
    const proposal = loadAndValidateProposal(PROPOSAL, MAPPING).proposal;
    const health = baseCategory("cat_health", "الرعاية الصحية");
    const otherCat = baseCategory("cat_other", "بيانات غير محددة");
    const current = {
      categories: [health, otherCat],
      classifications: [
        baseClassification({
          id: "cls_appts",
          nameAr: "المواعيد والإحالات الصحية",
          categoryId: health.id,
          categoryName: health.nameAr,
        }),
        baseClassification({
          id: "cls_other",
          nameAr: "أخرى تحتاج مراجعة",
          categoryId: otherCat.id,
          categoryName: otherCat.nameAr,
          isActive: false,
        }),
      ],
      fingerprint: "f",
    };
    const ctx = createPlanningContext(current, proposal);
    ensureProposedClassifications(ctx);

    expect(ctx.plan.finalClassificationTargets.HEALTH_APPOINTMENTS?.reuseId).toBe("cls_appts");
    expect(ctx.plan.classificationsToKeep.some((c) => c.currentId === "cls_appts")).toBe(true);
    expect(
      ctx.plan.classificationsToCreate.some((c) => c.classificationKey === "HEALTH_APPOINTMENTS")
    ).toBe(false);

    expect(ctx.plan.finalClassificationTargets.OTHER_REVIEW?.reuseId).toBe("cls_other");
    expect(ctx.plan.classificationsToReactivate.some((c) => c.currentId === "cls_other")).toBe(true);
    expect(ctx.plan.classificationsToCreate.some((c) => c.classificationKey === "OTHER_REVIEW")).toBe(
      false
    );

    expect(ctx.plan.finalClassificationTargets.HEALTH_QUALITY?.reuseId).toBeNull();
    expect(ctx.plan.classificationsToCreate.some((c) => c.classificationKey === "HEALTH_QUALITY")).toBe(
      true
    );
  });

  it("records AMBIGUOUS without CREATE and does not duplicate KEEP/REACTIVATE", () => {
    const proposal = loadAndValidateProposal(PROPOSAL, MAPPING).proposal;
    const otherCat = baseCategory("c1", "بيانات غير محددة");
    const health = baseCategory("cat_h", "الرعاية الصحية");
    const current = {
      categories: [otherCat, health],
      classifications: [
        baseClassification({
          id: "dup1",
          nameAr: "أخرى تحتاج مراجعة",
          categoryId: otherCat.id,
          categoryName: otherCat.nameAr,
        }),
        baseClassification({
          id: "dup2",
          nameAr: "أخرى تحتاج مراجعة",
          categoryId: otherCat.id,
          categoryName: otherCat.nameAr,
        }),
        baseClassification({
          id: "active_keep",
          nameAr: "المواعيد والإحالات الصحية",
          categoryId: health.id,
          categoryName: health.nameAr,
        }),
      ],
      fingerprint: "f",
    };

    const ctx = createPlanningContext(current, proposal);
    ensureProposedClassifications(ctx);
    expect(ctx.plan.namingConflicts.some((c) => c.includes("أخرى تحتاج مراجعة"))).toBe(true);
    expect(ctx.plan.classificationsToCreate.some((c) => c.classificationKey === "OTHER_REVIEW")).toBe(
      false
    );
    expect(ctx.plan.finalClassificationTargets.OTHER_REVIEW?.reuseId).toBeNull();

    expect(ctx.plan.classificationsToKeep.filter((c) => c.currentId === "active_keep")).toHaveLength(
      1
    );
    ensureProposedClassifications(ctx);
    expect(ctx.plan.classificationsToKeep.filter((c) => c.currentId === "active_keep")).toHaveLength(
      1
    );

    ctx.plan.classificationsToReactivate.push(
      buildPlanChange({
        currentId: "react1",
        currentName: "x",
        targetName: "x",
        currentCategory: null,
        targetCategory: "y",
        action: "REACTIVATE",
        reason: "seed",
        affectedExistingComplaintCount: 0,
        classificationKey: "STAFF_CONDUCT",
      })
    );
    const before = ctx.plan.classificationsToReactivate.length;
    ctx.classificationReuseByKey.set("STAFF_CONDUCT", "react1");
    ensureProposedClassifications(ctx);
    expect(ctx.plan.classificationsToReactivate).toHaveLength(before);
  });
});

describe("shared target category migrations", () => {
  function buildSharedTargetProposal(migrationsReversed = false) {
    const proposal = loadAndValidateProposal(PROPOSAL, MAPPING).proposal;
    const migrations = [
      {
        entityType: "Category+Classification" as const,
        currentId: "cat_b / cls_b",
        currentName: "مصدر ب / فرعي ب",
        target: "هدف مشترك / فرعي ب",
        action: "MOVE_AND_RENAME",
        details: "second",
      },
      {
        entityType: "Category+Classification" as const,
        currentId: "cat_a / cls_a",
        currentName: "مصدر أ / فرعي أ",
        target: "هدف مشترك / فرعي أ",
        action: "MOVE_AND_RENAME",
        details: "first",
      },
    ];
    proposal.currentEntityMigration = migrationsReversed ? migrations : [...migrations].reverse();
    proposal.proposedTaxonomy = [
      {
        category: "هدف مشترك",
        projectedCount: 2,
        classifications: [
          {
            category: "هدف مشترك",
            classification: "فرعي أ",
            classificationKey: "SHARED_A",
            sourceDetails: ["أ"],
            mappedCount: 1,
            legacyPreservedCount: 0,
            projectedCount: 1,
          },
          {
            category: "هدف مشترك",
            classification: "فرعي ب",
            classificationKey: "SHARED_B",
            sourceDetails: ["ب"],
            mappedCount: 1,
            legacyPreservedCount: 0,
            projectedCount: 1,
          },
        ],
      },
    ];
    return proposal;
  }

  function buildSharedCurrent() {
    return {
      categories: [
        {
          id: "cat_a",
          nameAr: "مصدر أ",
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
        {
          id: "cat_b",
          nameAr: "مصدر ب",
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
      ],
      classifications: [
        {
          id: "cls_a",
          nameAr: "فرعي أ",
          categoryId: "cat_a",
          categoryName: "مصدر أ",
          keywords: [],
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
        {
          id: "cls_b",
          nameAr: "فرعي ب",
          categoryId: "cat_b",
          categoryName: "مصدر ب",
          keywords: [],
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
      ],
      fingerprint: "f",
    };
  }

  it("does not rename two source categories onto the same target name", () => {
    const proposal = buildSharedTargetProposal(false);
    const ctx = createPlanningContext(buildSharedCurrent(), proposal);
    indexProposedTaxonomy(ctx);
    processEntityMigrations(ctx);
    const renamesToShared = ctx.plan.categoriesToRename.filter(
      (c) => c.targetName === "هدف مشترك"
    );
    expect(renamesToShared).toHaveLength(1);
    expect(renamesToShared[0]?.currentId).toBe("cat_a");
    expect(ctx.categoryReuseByTargetName.get("هدف مشترك")).toBe("cat_a");
    expect(ctx.plan.classificationsToMove.map((m) => m.currentId).sort()).toEqual([
      "cls_a",
      "cls_b",
    ]);
  });

  it("picks the lexicographically smallest category id regardless of migration order", () => {
    const proposal = buildSharedTargetProposal(true);
    const ctx = createPlanningContext(buildSharedCurrent(), proposal);
    indexProposedTaxonomy(ctx);
    processEntityMigrations(ctx);
    expect(ctx.categoryReuseByTargetName.get("هدف مشترك")).toBe("cat_a");
    expect(
      ctx.plan.categoriesToRename.filter((c) => c.targetName === "هدف مشترك")
    ).toHaveLength(1);
    expect(ctx.plan.categoriesToRename[0]?.currentId).toBe("cat_a");
  });

  it("resolves SPLIT classification target through the renamed category identity", () => {
    const proposal = loadAndValidateProposal(PROPOSAL, MAPPING).proposal;
    proposal.currentEntityMigration = [
      {
        entityType: "Category",
        currentId: "cat_old",
        currentName: "اسم قديم",
        target: "اسم نهائي",
        action: "RENAME",
        details: "rename parent",
      },
      {
        entityType: "Classification",
        currentId: "cls_split",
        currentName: "تصنيف مجزأ",
        target: "تصنيف مجزأ",
        action: "SPLIT",
        details: "split keeps classification under renamed category",
      },
    ];
    proposal.proposedTaxonomy = [
      {
        category: "اسم نهائي",
        projectedCount: 1,
        classifications: [
          {
            category: "اسم نهائي",
            classification: "تصنيف مجزأ",
            classificationKey: "SPLIT_KEY",
            sourceDetails: ["كلمة"],
            mappedCount: 1,
            legacyPreservedCount: 0,
            projectedCount: 1,
          },
        ],
      },
    ];
    const current = {
      categories: [
        {
          id: "cat_old",
          nameAr: "اسم قديم",
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
      ],
      classifications: [
        {
          id: "cls_split",
          nameAr: "تصنيف مجزأ",
          categoryId: "cat_old",
          categoryName: "اسم قديم",
          keywords: ["كلمة"],
          isActive: true,
          isDeleted: false,
          complaintCount: 0,
        },
      ],
      fingerprint: "f",
    };
    const ctx = createPlanningContext(current, proposal);
    indexProposedTaxonomy(ctx);
    processEntityMigrations(ctx);
    expect(ctx.plan.categoriesToRename).toEqual([
      expect.objectContaining({ currentId: "cat_old", targetName: "اسم نهائي" }),
    ]);
    expect(ctx.plan.classificationsToSplit).toEqual([
      expect.objectContaining({
        currentId: "cls_split",
        targetCategory: "اسم نهائي",
        targetName: "تصنيف مجزأ",
      }),
    ]);
    expect(ctx.plan.categoriesToCreate).toHaveLength(0);
  });
});

describe("operational shape fingerprint active-only contract", () => {
  const activeCat = { nameAr: "الرعاية الصحية", isActive: true, isDeleted: false };
  const activeCls = {
    nameAr: "المواعيد",
    categoryName: "الرعاية الصحية",
    keywords: ["موعد"],
    isActive: true,
    isDeleted: false,
  };

  it("ignores inactive categories and classifications", () => {
    const base = computeTaxonomyShapeFingerprint([activeCat], [activeCls]);
    expect(
      computeTaxonomyShapeFingerprint(
        [activeCat, { nameAr: "غير نشطة", isActive: false, isDeleted: false }],
        [activeCls]
      )
    ).toBe(base);
    expect(
      computeTaxonomyShapeFingerprint(
        [activeCat],
        [
          activeCls,
          {
            nameAr: "تصنيف معطل",
            categoryName: "الرعاية الصحية",
            keywords: ["x"],
            isActive: false,
            isDeleted: false,
          },
        ]
      )
    ).toBe(base);
  });

  it("changes when active names or keywords change", () => {
    const base = computeTaxonomyShapeFingerprint([activeCat], [activeCls]);
    expect(
      computeTaxonomyShapeFingerprint([{ ...activeCat, nameAr: "اسم آخر" }], [activeCls])
    ).not.toBe(base);
    expect(
      computeTaxonomyShapeFingerprint(
        [activeCat],
        [{ ...activeCls, nameAr: "تصنيف آخر" }]
      )
    ).not.toBe(base);
    expect(
      computeTaxonomyShapeFingerprint(
        [activeCat],
        [{ ...activeCls, keywords: ["كلمة مختلفة"] }]
      )
    ).not.toBe(base);
  });
});
