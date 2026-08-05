import { describe, expect, it, vi } from "vitest";
import { TaxonomyRestructureError } from "./classification-taxonomy-proposal";
import {
  dispatchRestructureMode,
  formatRestructureCliError,
  handleUnhandledCliFailure,
  type RestructureCliOptions,
} from "./restructure-cli-runtime";

function baseOptions(overrides: Partial<RestructureCliOptions> = {}): RestructureCliOptions {
  return {
    mode: "dry-run",
    actor: "system",
    proposal: "p.json",
    mapping: "m.csv",
    manifest: "manifest.json",
    confirm: null,
    runId: null,
    overwrite: false,
    ...overrides,
  };
}

describe("restructure CLI runtime", () => {
  it("dispatches dry-run, apply, verify, and rollback to the correct handlers", async () => {
    const calls: string[] = [];
    const handlers = {
      dryRun: async () => {
        calls.push("dry-run");
        return 0;
      },
      apply: async () => {
        calls.push("apply");
        return 0;
      },
      verify: async () => {
        calls.push("verify");
        return 0;
      },
      rollback: async () => {
        calls.push("rollback");
        return 0;
      },
    };

    await dispatchRestructureMode(baseOptions({ mode: "dry-run" }), handlers);
    await dispatchRestructureMode(baseOptions({ mode: "apply" }), handlers);
    await dispatchRestructureMode(baseOptions({ mode: "verify", runId: "r1" }), handlers);
    await dispatchRestructureMode(baseOptions({ mode: "rollback", runId: "r1" }), handlers);
    expect(calls).toEqual(["dry-run", "apply", "verify", "rollback"]);
  });

  it("rejects unsupported modes", async () => {
    await expect(
      dispatchRestructureMode(baseOptions({ mode: "explode" }), {
        dryRun: async () => 0,
        apply: async () => 0,
        verify: async () => 0,
        rollback: async () => 0,
      })
    ).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });

  it("handles disconnect-style rejection with safe output and exitCode 1", async () => {
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
    expect(printed[0]).toEqual({
      error: { code: "UNEXPECTED_ERROR", message: "disconnect rejected" },
    });
    expect(JSON.stringify(printed[0])).not.toContain("DATABASE_URL");
    expect(JSON.stringify(printed[0])).not.toContain("stack");
  });

  it("formats TaxonomyRestructureError without stack", () => {
    const formatted = formatRestructureCliError(
      new TaxonomyRestructureError("PROPOSAL_REQUIRED", "proposal required")
    );
    expect(formatted).toEqual({
      code: "PROPOSAL_REQUIRED",
      message: "proposal required",
      details: undefined,
    });
    vi.spyOn(console, "log");
    handleUnhandledCliFailure(new Error("x".repeat(500) + " DATABASE_URL=secret"), {
      print: (value) => {
        expect(JSON.stringify(value)).not.toContain("DATABASE_URL");
        expect((value as { error: { message: string } }).error.message.length).toBeLessThanOrEqual(200);
      },
      setExitCode: () => undefined,
    });
  });
});
