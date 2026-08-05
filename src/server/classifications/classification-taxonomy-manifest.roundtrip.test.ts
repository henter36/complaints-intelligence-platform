import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import {
  previewTaxonomyRestructure,
  readAndValidateManifest,
  computeManifestHash,
  buildConfirmationToken,
  stableStringify,
  sha256,
} from "./classification-taxonomy-restructure";

const FIXTURE_DIR = join(process.cwd(), "src/server/classifications/__fixtures__");
const PROPOSAL = join(FIXTURE_DIR, "mini-proposed-taxonomy.json");
const MAPPING = join(FIXTURE_DIR, "mini-source-detail-mapping.csv");

let prisma: PrismaClient | undefined;
let tempDir: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  tempDir = mkdtempSync(join(tmpdir(), "cip-manifest-roundtrip-"));
  const dbPath = join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: "pipe",
  });
  prisma = new PrismaClient();
  await prisma.category.create({ data: { nameAr: "فئة اختبار" } });
}, 60_000);

afterAll(async () => {
  try {
    if (prisma) await prisma.$disconnect();
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("taxonomy restructure manifest round-trip", () => {
  it("writes and re-reads a manifest without MANIFEST_HASH_MISMATCH", async () => {
    if (!prisma || !tempDir) throw new Error("not initialized");
    const manifestPath = join(tempDir, "manifest-roundtrip.json");
    const preview = await previewTaxonomyRestructure(prisma, {
      proposalPath: PROPOSAL,
      mappingPath: MAPPING,
      manifestPath,
      overwrite: true,
    });
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(JSON.stringify(onDisk)).not.toContain("undefined");
    const { manifestHash, confirmationToken, ...rest } = onDisk;
    expect(computeManifestHash(rest)).toBe(manifestHash);
    expect(confirmationToken).toBe(
      buildConfirmationToken(manifestHash, rest.totals.changeCount)
    );
    expect(confirmationToken).toBe(preview.confirmationToken);
    expect(sha256(stableStringify(rest))).toBe(manifestHash);
    expect(() => readAndValidateManifest(manifestPath)).not.toThrow();
    const loaded = readAndValidateManifest(manifestPath);
    expect(loaded.manifestHash).toBe(preview.manifestHash);
    expect(loaded.confirmationToken).toBe(preview.confirmationToken);
  });
});
