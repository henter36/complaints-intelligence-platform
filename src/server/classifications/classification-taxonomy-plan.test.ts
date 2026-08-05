import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  computeTaxonomyShapeFingerprint,
  emptyPlan,
} from "./classification-taxonomy-manifest";
import {
  assertPlanIsApplicable,
  createPlanningContext,
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
