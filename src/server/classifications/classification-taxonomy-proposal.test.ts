import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TaxonomyRestructureError,
  loadAndValidateProposal,
  buildConfirmationToken,
  RESTRUCTURE_ERROR_CODES,
  stableStringify,
  sha256,
} from "./classification-taxonomy-proposal";
import { buildClassificationPath } from "@/lib/reports/classification-keys";
import { assertClassificationNameDiffersFromCategory } from "./classification-management-service";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";

const FIXTURE_DIR = join(process.cwd(), "src/server/classifications/__fixtures__");
const PROPOSAL = join(FIXTURE_DIR, "mini-proposed-taxonomy.json");
const MAPPING = join(FIXTURE_DIR, "mini-source-detail-mapping.csv");

function withTempDir(prefix: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("stableStringify canonical hashing", () => {
  it("is independent of object key insertion order", () => {
    const left = { schemaVersion: 1, totals: { a: 1 }, period: { from: "x", to: "y" } };
    const right = { period: { to: "y", from: "x" }, totals: { a: 1 }, schemaVersion: 1 };
    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(sha256(stableStringify(left))).toBe(sha256(stableStringify(right)));
  });

  it("preserves array order", () => {
    expect(stableStringify({ rows: ["b", "a"] })).not.toBe(stableStringify({ rows: ["a", "b"] }));
  });

  it("omits object undefined and turns array undefined into null", () => {
    const serialized = stableStringify({
      keep: "yes",
      classificationKey: undefined,
      nested: { a: 1, b: undefined },
      rows: ["a", undefined, "c"],
    });
    expect(serialized).not.toContain("undefined");
    expect(serialized).toBe(
      stableStringify({ keep: "yes", nested: { a: 1 }, rows: ["a", null, "c"] })
    );
    expect(JSON.parse(serialized)).toEqual({
      keep: "yes",
      nested: { a: 1 },
      rows: ["a", null, "c"],
    });
  });

  it("matches JSON.stringify round-trip for hashing", () => {
    const payload = {
      schemaVersion: 1,
      plan: {
        change: {
          currentId: "x",
          classificationKey: undefined as string | undefined,
          keywords: ["a", undefined as unknown as string],
        },
      },
    };
    const before = sha256(stableStringify(payload));
    const roundTripped = JSON.parse(JSON.stringify(payload));
    expect(sha256(stableStringify(roundTripped))).toBe(before);
  });

  it("keeps proposalHash and mappingHash stable for the same fixture files", () => {
    const first = loadAndValidateProposal(PROPOSAL, MAPPING);
    const second = loadAndValidateProposal(PROPOSAL, MAPPING);
    expect(first.proposalHash).toBe(second.proposalHash);
    expect(first.mappingHash).toBe(second.mappingHash);
  });

  it("changes hash when a real value changes", () => {
    const before = sha256(stableStringify({ keyword: "أ" }));
    const after = sha256(stableStringify({ keyword: "ب" }));
    expect(after).not.toBe(before);
  });
});

describe("classification taxonomy proposal validation", () => {
  it("loads a valid proposal and mapping", () => {
    const { proposal, proposalHash, mappingHash } = loadAndValidateProposal(PROPOSAL, MAPPING);
    expect(proposal.status).toBe("PROPOSED_NOT_APPLIED");
    expect(proposal.proposedTaxonomy).toHaveLength(3);
    expect(proposal.sourceDetailMappings).toHaveLength(3);
    expect(proposalHash).toHaveLength(64);
    expect(mappingHash).toHaveLength(64);
    const other = proposal.sourceDetailMappings.find((m) => m.sourceDetail === "أخرى");
    expect(other?.classificationKey).toBe("OTHER_REVIEW");
    expect(other?.proposedPath).toBe("بيانات غير محددة / أخرى تحتاج مراجعة");
    expect(other?.currentPath).toBeUndefined();
  });

  it("accepts mappings that omit optional metadata fields", () => {
    withTempDir("cip-restructure-optional-sd-", (dir) => {
      const good = JSON.parse(readFileSync(PROPOSAL, "utf8"));
      good.sourceDetailMappings = good.sourceDetailMappings.map(
        (m: Record<string, unknown>) => ({
          sourceDetail: m.sourceDetail,
          count: m.count,
          proposedPath: m.proposedPath,
          classificationKey: m.classificationKey,
        })
      );
      const path = join(dir, "good.json");
      writeFileSync(path, JSON.stringify(good));
      const { proposal } = loadAndValidateProposal(path, MAPPING);
      expect(proposal.sourceDetailMappings).toHaveLength(3);
    });
  });

  it("rejects invalid required sourceDetailMapping fields", () => {
    const cases: Array<{ mutate: (m: Record<string, unknown>) => void; label: string }> = [
      { label: "missing sourceDetail", mutate: (m) => delete m.sourceDetail },
      { label: "missing count", mutate: (m) => delete m.count },
      { label: "string count", mutate: (m) => { m.count = "1"; } },
      { label: "negative count", mutate: (m) => { m.count = -1; } },
      { label: "missing proposedPath", mutate: (m) => delete m.proposedPath },
      { label: "missing classificationKey", mutate: (m) => delete m.classificationKey },
      { label: "non-string optional", mutate: (m) => { m.decision = 12; } },
    ];
    for (const testCase of cases) {
      withTempDir("cip-restructure-sd-invalid-", (dir) => {
        const bad = JSON.parse(readFileSync(PROPOSAL, "utf8"));
        testCase.mutate(bad.sourceDetailMappings[0] as Record<string, unknown>);
        const path = join(dir, "bad.json");
        writeFileSync(path, JSON.stringify(bad));
        expect(() => loadAndValidateProposal(path, MAPPING), testCase.label).toThrowError(
          expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID })
        );
      });
    }
  });

  it("rejects missing proposal and mapping paths", () => {
    expect(() => loadAndValidateProposal("", MAPPING)).toThrowError(
      expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.PROPOSAL_REQUIRED })
    );
    expect(() => loadAndValidateProposal(PROPOSAL, "")).toThrowError(
      expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.MAPPING_REQUIRED })
    );
  });

  it("rejects missing proposal or mapping files", () => {
    expect(() => loadAndValidateProposal("/tmp/missing-proposal.json", MAPPING)).toThrowError(
      expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.PROPOSAL_NOT_FOUND })
    );
    expect(() => loadAndValidateProposal(PROPOSAL, "/tmp/missing-mapping.csv")).toThrowError(
      expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.MAPPING_NOT_FOUND })
    );
  });

  it("rejects unsupported schema versions", () => {
    withTempDir("cip-restructure-schema-", (dir) => {
      const bad = JSON.parse(readFileSync(PROPOSAL, "utf8"));
      bad.schemaVersion = 99;
      const path = join(dir, "bad.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadAndValidateProposal(path, MAPPING)).toThrowError(
        expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.PROPOSAL_SCHEMA_UNSUPPORTED })
      );
    });
  });

  it("rejects invalid proposal status", () => {
    withTempDir("cip-restructure-status-", (dir) => {
      const bad = JSON.parse(readFileSync(PROPOSAL, "utf8"));
      bad.status = "APPLIED";
      const path = join(dir, "bad.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadAndValidateProposal(path, MAPPING)).toThrowError(
        expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.PROPOSAL_STATUS_INVALID })
      );
    });
  });

  it("rejects inconsistent validation totals", () => {
    withTempDir("cip-restructure-totals-", (dir) => {
      const bad = JSON.parse(readFileSync(PROPOSAL, "utf8"));
      bad.validation.projectedTotalComplaintCount = 1;
      const path = join(dir, "bad.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadAndValidateProposal(path, MAPPING)).toThrowError(
        expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.PROPOSAL_INVALID })
      );
    });
  });

  it("rejects duplicate classificationKey", () => {
    withTempDir("cip-restructure-dup-key-", (dir) => {
      const bad = JSON.parse(readFileSync(PROPOSAL, "utf8"));
      const first = bad.proposedTaxonomy[0].classifications[0];
      bad.proposedTaxonomy[1].classifications[0].classificationKey = first.classificationKey;
      const path = join(dir, "bad.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadAndValidateProposal(path, MAPPING)).toThrowError(
        expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.DUPLICATE_CLASSIFICATION_KEY })
      );
    });
  });

  it("rejects duplicate sourceDetail", () => {
    withTempDir("cip-restructure-dup-sd-", (dir) => {
      const bad = JSON.parse(readFileSync(PROPOSAL, "utf8"));
      bad.sourceDetailMappings[1].sourceDetail = bad.sourceDetailMappings[0].sourceDetail;
      const path = join(dir, "bad.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadAndValidateProposal(path, MAPPING)).toThrowError(
        expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.DUPLICATE_SOURCE_DETAIL })
      );
    });
  });

  it("rejects classification name equal to category name", () => {
    withTempDir("cip-restructure-name-", (dir) => {
      const bad = JSON.parse(readFileSync(PROPOSAL, "utf8"));
      bad.proposedTaxonomy[0].classifications[0].classification =
        bad.proposedTaxonomy[0].classifications[0].category;
      const path = join(dir, "bad.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadAndValidateProposal(path, MAPPING)).toThrowError(
        expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.NAMING_CONFLICT })
      );
    });
  });

  it("rejects أخرى mapped to the wrong path", () => {
    withTempDir("cip-restructure-other-", (dir) => {
      const bad = JSON.parse(readFileSync(PROPOSAL, "utf8"));
      const other = bad.sourceDetailMappings.find(
        (m: { sourceDetail: string }) => m.sourceDetail === "أخرى"
      );
      other.proposedPath = "الرعاية الصحية / مواعيد";
      other.classificationKey = "WRONG";
      const path = join(dir, "bad.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadAndValidateProposal(path, MAPPING)).toThrowError(
        expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.OTHER_REVIEW_MISSING })
      );
    });
  });

  it("rejects mismatched JSON and CSV row counts", () => {
    withTempDir("cip-restructure-map-", (dir) => {
      const path = join(dir, "bad.csv");
      writeFileSync(
        path,
        "قيمة تفصيل,عدد الشكاوى,المسار المقترح,مفتاح التصنيف\nأخرى,1,بيانات غير محددة / أخرى تحتاج مراجعة,OTHER_REVIEW\n",
        "utf8"
      );
      expect(() => loadAndValidateProposal(PROPOSAL, path)).toThrowError(
        expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.MAPPING_MISMATCH })
      );
    });
  });

  it("rejects CSV count mismatches", () => {
    withTempDir("cip-restructure-map-fields-", (dir) => {
      const original = readFileSync(MAPPING, "utf8").trim().split("\n");
      const header = original[0]!;
      const rows = original.slice(1).map((line) => {
        const cols = line.split(",");
        if (cols[0] === "أخرى") cols[1] = "999";
        return cols.join(",");
      });
      const path = join(dir, "bad-count.csv");
      writeFileSync(path, [header, ...rows].join("\n"), "utf8");
      expect(() => loadAndValidateProposal(PROPOSAL, path)).toThrowError(
        expect.objectContaining({ code: RESTRUCTURE_ERROR_CODES.MAPPING_MISMATCH })
      );
    });
  });

  it("builds confirmation tokens from manifest hash and change count", () => {
    expect(buildConfirmationToken("abcdef1234567890", 12)).toBe("RESTRUCTURE-12-ABCDEF1234");
  });
});

describe("classification path and naming guards", () => {
  it("builds classificationPath for reports", () => {
    expect(buildClassificationPath("الرعاية الصحية", "المواعيد والإحالات الصحية")).toBe(
      "الرعاية الصحية / المواعيد والإحالات الصحية"
    );
  });

  it("avoids main/main display when names match", () => {
    expect(buildClassificationPath("الرعاية الصحية", "الرعاية الصحية")).toBe("الرعاية الصحية");
  });

  it("rejects classification name equal to category name", () => {
    expect(() => assertClassificationNameDiffersFromCategory("الرعاية الصحية", "الرعاية الصحية")).toThrow(
      /مختلفًا عن اسم التصنيف الرئيسي/
    );
  });

  it("rejects equal names after Arabic normalization", () => {
    expect(() =>
      assertClassificationNameDiffersFromCategory("الرعاية الصحية", "الرعاية  الصحيّة")
    ).toThrow(/CLASSIFICATION_NAME_EQUALS_CATEGORY_NAME|مختلفًا/);
    const a = normalizeClassificationKeyword("أخرى");
    const b = normalizeClassificationKeyword("اخرى");
    expect(a).toBe(b);
  });
});

describe("restructure does not auto-run backfill", () => {
  it("CLI script does not import historical backfill modules", () => {
    const cli = readFileSync(
      join(process.cwd(), "scripts/restructure-classification-taxonomy.ts"),
      "utf8"
    );
    expect(cli).not.toMatch(/classification-historical-backfill|classifications:backfill/);
    expect(cli).toContain("dry-run");
    expect(
      existsSync(join(process.cwd(), "src/server/classifications/classification-taxonomy-restructure.ts"))
    ).toBe(true);
  });
});
