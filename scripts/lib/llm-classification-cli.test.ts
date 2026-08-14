import { describe, expect, it, vi } from "vitest";
import { artifactBasename, runLlmClassificationCli } from "./llm-classification-cli";

describe("LLM classification CLI lifecycle", () => {
  it("reports the basename of a custom semantic catalog output path", () => {
    expect(artifactBasename("/private/operator/path/custom-catalog.json"))
      .toBe("custom-catalog.json");
  });

  it("handles disconnect rejection without an unhandled promise rejection", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockRejectedValue(new Error("sensitive disconnect detail"));
    const reportError = vi.fn();
    const setExitCode = vi.fn();

    await expect(runLlmClassificationCli({
      run,
      disconnect,
      reportError,
      setExitCode,
    })).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith("LLM_CLASSIFICATION_DISCONNECT_FAILED");
    expect(reportError).not.toHaveBeenCalledWith(expect.stringContaining("sensitive"));
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it("always disconnects and safely reports a run failure", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const reportError = vi.fn();
    const setExitCode = vi.fn();

    await runLlmClassificationCli({
      run: async () => {
        throw new Error("raw secret detail");
      },
      disconnect,
      reportError,
      setExitCode,
    });

    expect(disconnect).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith("LLM_CLASSIFICATION_OPERATION_FAILED");
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});
