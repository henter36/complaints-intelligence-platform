import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const LLM_CLASSIFICATION_LOCAL_ROOT = resolve(
  process.cwd(),
  ".local/llm-classification"
);

export function resolveLlmClassificationArtifact(path: string): string {
  const absolute = resolve(path);
  const relativePath = relative(LLM_CLASSIFICATION_LOCAL_ROOT, absolute);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new Error("LLM_ARTIFACT_PATH_OUTSIDE_LOCAL_ROOT");
  }
  return absolute;
}

export function readLlmClassificationJson<T>(path: string): T {
  const safePath = resolveLlmClassificationArtifact(path);
  return JSON.parse(readFileSync(safePath, "utf8")) as T;
}

export function writeLlmClassificationJson(
  path: string,
  value: unknown,
  options: { private?: boolean } = {}
): string {
  const safePath = resolveLlmClassificationArtifact(path);
  mkdirSync(dirname(safePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${safePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: options.private ? 0o600 : 0o640,
  });
  renameSync(temporaryPath, safePath);
  chmodSync(safePath, options.private ? 0o600 : 0o640);
  return safePath;
}

export function artifactTimestamp(date = new Date()): string {
  return date.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
