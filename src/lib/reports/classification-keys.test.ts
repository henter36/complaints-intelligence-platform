import { describe, expect, it } from "vitest";
import {
  classificationKey,
  UNCLASSIFIED_CLASSIFICATION_KEY,
  UNCLASSIFIED_CLASSIFICATION_LABEL,
} from "./classification-keys";

describe("classification keys", () => {
  it("uses a stable sentinel for null/blank ids and Arabic label for display only", () => {
    expect(classificationKey(null)).toBe(UNCLASSIFIED_CLASSIFICATION_KEY);
    expect(classificationKey(undefined)).toBe(UNCLASSIFIED_CLASSIFICATION_KEY);
    expect(classificationKey("")).toBe(UNCLASSIFIED_CLASSIFICATION_KEY);
    expect(classificationKey("c1")).toBe("c1");
    expect(UNCLASSIFIED_CLASSIFICATION_LABEL).toBe("غير مصنف");
    expect(UNCLASSIFIED_CLASSIFICATION_KEY).not.toBe(UNCLASSIFIED_CLASSIFICATION_LABEL);
  });
});
