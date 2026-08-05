import { describe, expect, it, vi } from "vitest";
import { createImportClassificationContext } from "./import-confirmation-service";

describe("createImportClassificationContext", () => {
  it("loads taxonomy fingerprint once for repeated getTaxonomyFingerprint calls", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "c1",
        nameAr: "أ",
        keywords: ["ك"],
        isActive: true,
        isDeleted: false,
        category: { id: "cat", nameAr: "فئة", isActive: true, isDeleted: false },
      },
    ]);
    const tx = { classification: { findMany } } as never;
    const context = createImportClassificationContext(tx);

    const first = await context.getTaxonomyFingerprint();
    const second = await context.getTaxonomyFingerprint();
    const third = await Promise.all([
      context.getTaxonomyFingerprint(),
      context.getTaxonomyFingerprint(),
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(third[0]).toBe(first);
    expect(third[1]).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("loads once for 100 sequential requests", async () => {
    const findMany = vi.fn(async () => []);
    const context = createImportClassificationContext({
      classification: { findMany },
    } as never);

    const values = [];
    for (let i = 0; i < 100; i += 1) {
      values.push(await context.getTaxonomyFingerprint());
    }
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(new Set(values).size).toBe(1);
  });

  it("does not re-run the query for later rows when the fingerprint promise rejects", async () => {
    const findMany = vi.fn(async () => {
      throw new Error("taxonomy load failed");
    });
    const context = createImportClassificationContext({
      classification: { findMany },
    } as never);

    await expect(context.getTaxonomyFingerprint()).rejects.toThrow("taxonomy load failed");
    await expect(context.getTaxonomyFingerprint()).rejects.toThrow("taxonomy load failed");
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("uses a separate cache per context instance (new transaction)", async () => {
    const findManyA = vi.fn(async () => []);
    const findManyB = vi.fn(async () => []);
    const contextA = createImportClassificationContext({
      classification: { findMany: findManyA },
    } as never);
    const contextB = createImportClassificationContext({
      classification: { findMany: findManyB },
    } as never);

    await contextA.getTaxonomyFingerprint();
    await contextB.getTaxonomyFingerprint();
    await contextA.getTaxonomyFingerprint();

    expect(findManyA).toHaveBeenCalledTimes(1);
    expect(findManyB).toHaveBeenCalledTimes(1);
  });
});
