import { describe, expect, it } from "vitest";
import { buildPrismaChildEnvironment } from "./prisma-cli-runner";

describe("buildPrismaChildEnvironment", () => {
  it("includes only allowlisted environment keys and DATABASE_URL", () => {
    process.env.PATH = "/tmp/unsafe-path";
    process.env.NODE_PATH = "/tmp/node-path";
    process.env.TMPDIR = "/tmp";
    process.env.HOME = "/Users/test";

    const env = buildPrismaChildEnvironment("file:/tmp/test.db");

    expect(env.DATABASE_URL).toBe("file:/tmp/test.db");
    expect(env.HOME).toBe("/Users/test");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.PATH).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.npm_config_prefix).toBeUndefined();
  });
});
