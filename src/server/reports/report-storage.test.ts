// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let storageDir: string;

vi.mock("@/lib/env", () => ({
  get env() {
    return {
      reportStoragePath: storageDir,
      reportMaxFileSizeMb: 1,
    };
  },
}));

describe("report storage", () => {
  beforeEach(() => {
    storageDir = mkdtempSync(path.join(tmpdir(), "reports-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("stores a file with a random UUID-based key, never the caller-supplied name", async () => {
    const { storeReportArtifact } = await import("./report-storage");
    const stored = await storeReportArtifact(Buffer.from("hello"), "PDF");
    expect(stored.storageKey).toMatch(/^[0-9a-f-]{36}\.pdf$/);
  });

  it("computes a correct sha256 digest", async () => {
    const { storeReportArtifact, calculateSha256 } = await import("./report-storage");
    const buffer = Buffer.from("report-content");
    const stored = await storeReportArtifact(buffer, "XLSX");
    expect(stored.sha256).toBe(calculateSha256(buffer));
    expect(stored.sha256).toHaveLength(64);
  });

  it("rejects files larger than the configured limit", async () => {
    const { storeReportArtifact } = await import("./report-storage");
    const big = Buffer.alloc(2 * 1024 * 1024, 1); // 2MB > 1MB limit
    await expect(storeReportArtifact(big, "PDF")).rejects.toMatchObject({ code: "REPORT_FILE_TOO_LARGE" });
  });

  it("reads back exactly what was stored", async () => {
    const { storeReportArtifact, readReportArtifact } = await import("./report-storage");
    const buffer = Buffer.from("round-trip-content");
    const stored = await storeReportArtifact(buffer, "PDF");
    const readBuffer = await readReportArtifact(stored.storageKey);
    expect(readBuffer.equals(buffer)).toBe(true);
  });

  it("blocks path traversal by stripping directory components from the storage key", async () => {
    const { readReportArtifact } = await import("./report-storage");
    // path.basename() strips ".." segments, so this must resolve to a
    // (non-existent) file named "passwd" inside the storage root, not escape it.
    await expect(readReportArtifact("../../../etc/passwd")).rejects.toMatchObject({
      code: "REPORT_FILE_NOT_AVAILABLE",
    });
  });

  it("deleteReportArtifact is a safe no-op for a missing file", async () => {
    const { deleteReportArtifact } = await import("./report-storage");
    await expect(deleteReportArtifact("does-not-exist.pdf")).resolves.toBeUndefined();
  });

  it("deleteReportArtifact is a safe no-op when given null/undefined", async () => {
    const { deleteReportArtifact } = await import("./report-storage");
    await expect(deleteReportArtifact(null)).resolves.toBeUndefined();
    await expect(deleteReportArtifact(undefined)).resolves.toBeUndefined();
  });
});
