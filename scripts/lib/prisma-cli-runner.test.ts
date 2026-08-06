import { describe, expect, it } from "vitest";
import { buildPrismaChildEnvironment } from "./prisma-cli-runner";

const ENV_KEYS = ["PATH", "NODE_PATH", "npm_config_prefix", "TMPDIR", "HOME"] as const;

type EnvironmentKey = (typeof ENV_KEYS)[number];

function captureEnvironment(): Record<EnvironmentKey, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    EnvironmentKey,
    string | undefined
  >;
}

function restoreEnvironment(original: Record<EnvironmentKey, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("buildPrismaChildEnvironment", () => {
  it("includes only allowlisted environment keys and DATABASE_URL", () => {
    const original = captureEnvironment();

    try {
      process.env.PATH = "/tmp/unsafe-path";
      process.env.NODE_PATH = "/tmp/node-path";
      process.env.npm_config_prefix = "/tmp/npm-prefix";
      process.env.TMPDIR = "/tmp";
      process.env.HOME = "/Users/test";

      const env = buildPrismaChildEnvironment("file:/tmp/test.db");

      expect(env.DATABASE_URL).toBe("file:/tmp/test.db");
      expect(env.HOME).toBe("/Users/test");
      expect(env.TMPDIR).toBe("/tmp");
      expect(env.PATH).toBeUndefined();
      expect(env.NODE_PATH).toBeUndefined();
      expect(env.npm_config_prefix).toBeUndefined();
    } finally {
      restoreEnvironment(original);
    }
  });

  it("restoreEnvironment returns keys to their captured values", () => {
    const original = captureEnvironment();
    const mutatedPath = "/tmp/mutated-path";
    const mutatedHome = "/tmp/mutated-home";

    try {
      process.env.PATH = mutatedPath;
      process.env.NODE_PATH = "/tmp/mutated-node-path";
      process.env.npm_config_prefix = "/tmp/mutated-prefix";
      process.env.TMPDIR = "/tmp/mutated-tmpdir";
      process.env.HOME = mutatedHome;

      restoreEnvironment(original);

      if (original.PATH === undefined) {
        expect(process.env.PATH).toBeUndefined();
      } else {
        expect(process.env.PATH).toBe(original.PATH);
      }

      if (original.NODE_PATH === undefined) {
        expect(process.env.NODE_PATH).toBeUndefined();
      } else {
        expect(process.env.NODE_PATH).toBe(original.NODE_PATH);
      }

      if (original.npm_config_prefix === undefined) {
        expect(process.env.npm_config_prefix).toBeUndefined();
      } else {
        expect(process.env.npm_config_prefix).toBe(original.npm_config_prefix);
      }

      if (original.TMPDIR === undefined) {
        expect(process.env.TMPDIR).toBeUndefined();
      } else {
        expect(process.env.TMPDIR).toBe(original.TMPDIR);
      }

      if (original.HOME === undefined) {
        expect(process.env.HOME).toBeUndefined();
      } else {
        expect(process.env.HOME).toBe(original.HOME);
      }
    } finally {
      restoreEnvironment(original);
    }
  });

  it("restoreEnvironment deletes keys when originals were undefined", () => {
    const realOriginal = captureEnvironment();
    const blank: Record<EnvironmentKey, string | undefined> = {
      PATH: undefined,
      NODE_PATH: undefined,
      npm_config_prefix: undefined,
      TMPDIR: undefined,
      HOME: undefined,
    };

    try {
      process.env.PATH = "/tmp/should-delete-path";
      process.env.NODE_PATH = "/tmp/should-delete-node";
      process.env.npm_config_prefix = "/tmp/should-delete-prefix";
      process.env.TMPDIR = "/tmp/should-delete-tmpdir";
      process.env.HOME = "/tmp/should-delete-home";

      restoreEnvironment(blank);

      expect(process.env.PATH).toBeUndefined();
      expect(process.env.NODE_PATH).toBeUndefined();
      expect(process.env.npm_config_prefix).toBeUndefined();
      expect(process.env.TMPDIR).toBeUndefined();
      expect(process.env.HOME).toBeUndefined();
    } finally {
      restoreEnvironment(realOriginal);
    }
  });
});
