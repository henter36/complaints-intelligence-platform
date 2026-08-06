import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { restoreDatabaseUrl, withPreparedBenchmark } from "./benchmark-lifecycle";

describe("withPreparedBenchmark lifecycle", () => {
  it("deletes tempDir after success and disconnects first", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bench-life-ok-"));
    writeFileSync(join(tempDir, "marker.db"), "ok");
    const order: string[] = [];

    const value = await withPreparedBenchmark({
      tempDir,
      originalDatabaseUrl: undefined,
      disconnect: async () => {
        order.push("disconnect");
        expect(existsSync(tempDir)).toBe(true);
      },
      run: async () => {
        order.push("run");
        return 42;
      },
    });

    expect(value).toBe(42);
    expect(order).toEqual(["run", "disconnect"]);
    expect(existsSync(tempDir)).toBe(false);
  });

  it("deletes tempDir after run failure and still disconnects", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bench-life-fail-"));
    writeFileSync(join(tempDir, "marker.db"), "fail");
    const order: string[] = [];

    await expect(
      withPreparedBenchmark({
        tempDir,
        originalDatabaseUrl: "file:/tmp/original.db",
        disconnect: async () => {
          order.push("disconnect");
          expect(existsSync(tempDir)).toBe(true);
        },
        run: async () => {
          order.push("run");
          throw new Error("simulated analytics failure");
        },
      })
    ).rejects.toThrow(/simulated analytics failure/);

    expect(order).toEqual(["run", "disconnect"]);
    expect(existsSync(tempDir)).toBe(false);
    expect(process.env.DATABASE_URL).toBe("file:/tmp/original.db");
    delete process.env.DATABASE_URL;
  });

  it("deletes tempDir when output write callback fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bench-life-write-"));
    writeFileSync(join(tempDir, "marker.db"), "write");

    await expect(
      withPreparedBenchmark({
        tempDir,
        originalDatabaseUrl: undefined,
        disconnect: async () => undefined,
        run: async () => {
          throw new Error("simulated output write failure");
        },
      })
    ).rejects.toThrow(/simulated output write failure/);

    expect(existsSync(tempDir)).toBe(false);
  });

  it("restores DATABASE_URL when original was undefined", async () => {
    process.env.DATABASE_URL = "file:/tmp/leak.db";
    await withPreparedBenchmark({
      originalDatabaseUrl: undefined,
      run: async () => "ok",
    });
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});

describe("restoreDatabaseUrl", () => {
  it("deletes key when original is undefined", () => {
    process.env.DATABASE_URL = "file:/tmp/x.db";
    restoreDatabaseUrl(undefined);
    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  it("restores previous value when original is set", () => {
    process.env.DATABASE_URL = "file:/tmp/x.db";
    restoreDatabaseUrl("file:/tmp/y.db");
    expect(process.env.DATABASE_URL).toBe("file:/tmp/y.db");
    delete process.env.DATABASE_URL;
  });
});
