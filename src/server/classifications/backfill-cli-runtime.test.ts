import { describe, expect, it, vi } from "vitest";
import { HistoricalBackfillError } from "./historical-classification-backfill";
import {
  formatBackfillCliError,
  handleUnhandledCliFailure,
} from "./backfill-cli-runtime";

describe("backfill CLI runtime error handling", () => {
  it("formats HistoricalBackfillError without stack", () => {
    const formatted = formatBackfillCliError(
      new HistoricalBackfillError("BACKFILL_MANIFEST_REQUIRED", "manifest required")
    );
    expect(formatted).toEqual({
      code: "BACKFILL_MANIFEST_REQUIRED",
      message: "manifest required",
      details: undefined,
    });
    expect(JSON.stringify(formatted)).not.toContain("stack");
  });

  it("handles disconnect-style rejection with safe output and exitCode 1", () => {
    const printed: unknown[] = [];
    let exitCode: number | undefined;
    const disconnectError = new Error("PrismaClient disconnect failed");

    handleUnhandledCliFailure(disconnectError, {
      print: (value) => printed.push(value),
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(1);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toEqual({
      error: {
        code: "UNEXPECTED_ERROR",
        message: "PrismaClient disconnect failed",
      },
    });
    expect(JSON.stringify(printed[0])).not.toContain("DATABASE_URL");
    expect(JSON.stringify(printed[0])).not.toContain("stack");
  });

  it("does not leave an unhandled rejection when chained like the CLI entrypoint", async () => {
    const printed: unknown[] = [];
    let exitCode: number | undefined;
    const failingMain = async (): Promise<number> => {
      try {
        return 0;
      } finally {
        await Promise.reject(new Error("disconnect rejected"));
      }
    };

    await failingMain()
      .then((code) => {
        exitCode = code;
      })
      .catch((error) => {
        handleUnhandledCliFailure(error, {
          print: (value) => printed.push(value),
          setExitCode: (code) => {
            exitCode = code;
          },
        });
      });

    expect(exitCode).toBe(1);
    expect(printed[0]).toMatchObject({
      error: { code: "UNEXPECTED_ERROR", message: "disconnect rejected" },
    });
  });

  it("truncates unexpected messages and never includes spy secrets", () => {
    const long = "x".repeat(500);
    const formatted = formatBackfillCliError(new Error(`${long} DATABASE_URL=secret`));
    expect(formatted.message.length).toBeLessThanOrEqual(200);
    vi.spyOn(console, "log");
    handleUnhandledCliFailure(new Error("ok"), {
      print: (value) => {
        expect(JSON.stringify(value)).not.toContain("DATABASE_URL");
      },
      setExitCode: () => undefined,
    });
  });
});
