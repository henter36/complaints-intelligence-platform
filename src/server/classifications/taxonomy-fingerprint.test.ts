import { describe, expect, it, vi } from "vitest";
import { compareCodeUnits } from "./canonical-string-order";
import {
  buildTaxonomyFingerprintPayload,
  computeTaxonomyFingerprint,
} from "./taxonomy-fingerprint";
import {
  buildConfirmationToken,
  computeManifestHash,
  stableStringify,
  type BackfillManifest,
  type ManifestRow,
} from "./historical-classification-backfill";

function sampleTaxonomy() {
  return [
    {
      id: "cls-ب",
      nameAr: "تصنيف ب",
      keywords: ["كلمة ب", "كلمة أ"],
      isActive: true,
      isDeleted: false,
      category: { id: "cat-1", nameAr: "فئة", isActive: true, isDeleted: false },
    },
    {
      id: "cls-أ",
      nameAr: "تصنيف أ",
      keywords: ["تأخير", "موعد"],
      isActive: true,
      isDeleted: false,
      category: { id: "cat-1", nameAr: "فئة", isActive: true, isDeleted: false },
    },
  ];
}

describe("compareCodeUnits", () => {
  it("orders by UTF-16 code units without localeCompare", () => {
    expect(compareCodeUnits("أ", "ب")).toBe(compareCodeUnits("أ", "ب"));
    expect(["ب", "أ"].sort(compareCodeUnits)).toEqual(["أ", "ب"].sort(compareCodeUnits));
    const spy = vi.spyOn(String.prototype, "localeCompare");
    expect(compareCodeUnits("كلمة", "موعد")).not.toBeNaN();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("taxonomy fingerprint stability", () => {
  it("produces the same fingerprint regardless of input order", () => {
    const a = computeTaxonomyFingerprint(sampleTaxonomy());
    const b = computeTaxonomyFingerprint([...sampleTaxonomy()].reverse());
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sorts Arabic keywords with compareCodeUnits, not localeCompare", () => {
    const spy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("localeCompare must not be used for fingerprint ordering");
    });
    const payload = buildTaxonomyFingerprintPayload(sampleTaxonomy());
    expect(payload.map((e) => e.classificationId)).toEqual(
      [...payload.map((e) => e.classificationId)].sort(compareCodeUnits)
    );
    for (const entry of payload) {
      expect(entry.normalizedKeywords).toEqual(
        [...entry.normalizedKeywords].sort(compareCodeUnits)
      );
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("keeps classification ID ordering stable under localeCompare monkey-patch", () => {
    const spy = vi.spyOn(String.prototype, "localeCompare").mockReturnValue(1);
    const first = computeTaxonomyFingerprint(sampleTaxonomy());
    const second = computeTaxonomyFingerprint([...sampleTaxonomy()].reverse());
    expect(first).toBe(second);
    spy.mockRestore();
  });

  it("changes when a keyword, category, or classification changes", () => {
    const base = computeTaxonomyFingerprint(sampleTaxonomy());
    expect(
      computeTaxonomyFingerprint([
        { ...sampleTaxonomy()[0]!, keywords: ["كلمة مختلفة"] },
        sampleTaxonomy()[1]!,
      ])
    ).not.toBe(base);
    expect(
      computeTaxonomyFingerprint([
        sampleTaxonomy()[0]!,
        {
          ...sampleTaxonomy()[1]!,
          category: { id: "cat-2", nameAr: "فئة أخرى", isActive: true, isDeleted: false },
        },
      ])
    ).not.toBe(base);
    expect(
      computeTaxonomyFingerprint([
        sampleTaxonomy()[0]!,
        { ...sampleTaxonomy()[1]!, nameAr: "اسم مختلف" },
      ])
    ).not.toBe(base);
  });
});

describe("manifest hash + confirmation token canonical ordering", () => {
  const row = (id: string): ManifestRow => ({
    complaintId: id,
    expectedVersion: 1,
    previousClassificationId: null,
    previousAssignmentSource: null,
    targetClassificationId: "cls-1",
    targetCategoryId: "cat-1",
    targetClassificationName: "تصنيف",
    sourceDetailHash: "abc",
    matchCode: "MATCHED",
  });

  function sampleManifest(rows: ManifestRow[]): BackfillManifest {
    return {
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      period: { from: "2025-09-08", toInclusive: "2026-07-15", toExclusive: "2026-07-16" },
      taxonomyFingerprint: "fp",
      totals: {
        eligibleCount: 2,
        alreadyClassifiedCount: 0,
        manuallyProtectedCount: 0,
        ambiguousCount: 0,
        unmatchedCount: 0,
        missingSourceDetailCount: 0,
        inactiveTargetCount: 0,
        outsidePeriodCount: 0,
      },
      classificationDistribution: [
        {
          classificationId: "cls-2",
          classificationName: "ب",
          categoryId: "cat-1",
          categoryName: "فئة",
          eligibleCount: 1,
        },
        {
          classificationId: "cls-1",
          classificationName: "أ",
          categoryId: "cat-1",
          categoryName: "فئة",
          eligibleCount: 1,
        },
      ],
      rows,
      manifestHash: "",
      confirmationToken: "",
    };
  }

  it("manifest hash ignores object key insertion order", () => {
    const left = { schemaVersion: 1, totals: { eligibleCount: 2 }, period: { from: "a", to: "b" } };
    const right = { period: { to: "b", from: "a" }, totals: { eligibleCount: 2 }, schemaVersion: 1 };
    expect(stableStringify(left)).toBe(stableStringify(right));
  });

  it("manifest hash ignores row order before canonicalization", () => {
    const a = sampleManifest([row("cmp-2"), row("cmp-1")]);
    const b = sampleManifest([row("cmp-1"), row("cmp-2")]);
    expect(computeManifestHash(a)).toBe(computeManifestHash(b));
  });

  it("confirmation token derives from the canonical manifest hash", () => {
    const manifest = sampleManifest([row("cmp-1"), row("cmp-2")]);
    const hash = computeManifestHash(manifest);
    const token = buildConfirmationToken({
      manifestHash: hash,
      taxonomyFingerprint: manifest.taxonomyFingerprint,
      eligibleCount: manifest.totals.eligibleCount,
      periodFrom: manifest.period.from,
      periodTo: manifest.period.toInclusive,
    });
    expect(token).toMatch(/^APPLY-2-[A-F0-9]{10}$/);
    expect(
      buildConfirmationToken({
        manifestHash: hash,
        taxonomyFingerprint: manifest.taxonomyFingerprint,
        eligibleCount: manifest.totals.eligibleCount,
        periodFrom: manifest.period.from,
        periodTo: manifest.period.toInclusive,
      })
    ).toBe(token);
  });

  it("does not call localeCompare while hashing manifests", () => {
    const spy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("localeCompare must not affect manifest hash");
    });
    expect(computeManifestHash(sampleManifest([row("cmp-ب"), row("cmp-أ")]))).toMatch(
      /^[a-f0-9]{64}$/
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
