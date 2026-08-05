import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TaxonomyRestructureError,
  loadAndValidateProposal,
  buildConfirmationToken,
  RESTRUCTURE_ERROR_CODES,
} from "./classification-taxonomy-proposal";
import { buildClassificationPath } from "@/lib/reports/classification-keys";
import { assertClassificationNameDiffersFromCategory } from "./classification-management-service";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";

const FIXTURE_DIR = join(process.cwd(), "src/server/classifications/__fixtures__");
const PROPOSAL = join(FIXTURE_DIR, "mini-proposed-taxonomy.json");
const MAPPING = join(FIXTURE_DIR, "mini-source-detail-mapping.csv");

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
  });

  it("rejects unsupported schema versions", () => {
    const dir = mkdtempSync(join(tmpdir(), "cip-restructure-schema-"));
    try {
      const bad = JSON.parse(readFileSync(PROPOSAL, "utf8"));
      bad.schemaVersion = 99;
      const path = join(dir, "bad.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadAndValidateProposal(path, MAPPING)).toThrow(TaxonomyRestructureError);
      try {
        loadAndValidateProposal(path, MAPPING);
      } catch (error) {
        expect(error).toBeInstanceOf(TaxonomyRestructureError);
        expect((error as TaxonomyRestructureError).code).toBe(
          RESTRUCTURE_ERROR_CODES.PROPOSAL_SCHEMA_UNSUPPORTED
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects mismatched JSON and CSV mappings", () => {
    const dir = mkdtempSync(join(tmpdir(), "cip-restructure-map-"));
    try {
      const path = join(dir, "bad.csv");
      writeFileSync(
        path,
        "قيمة تفصيل,عدد الشكاوى,المسار المقترح,مفتاح التصنيف\nأخرى,999,بيانات غير محددة / أخرى تحتاج مراجعة,OTHER_REVIEW\n",
        "utf8"
      );
      expect(() => loadAndValidateProposal(PROPOSAL, path)).toThrow(TaxonomyRestructureError);
      try {
        loadAndValidateProposal(PROPOSAL, path);
      } catch (error) {
        expect((error as TaxonomyRestructureError).code).toBe(RESTRUCTURE_ERROR_CODES.MAPPING_MISMATCH);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(existsSync(join(process.cwd(), "src/server/classifications/classification-taxonomy-restructure.ts"))).toBe(
      true
    );
  });
});
