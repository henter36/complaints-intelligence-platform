import { describe, expect, it } from "vitest";
import {
  buildClassificationPath,
  classificationDisplayName,
  UNCLASSIFIED_CLASSIFICATION_LABEL,
} from "./classification-keys";

describe("buildClassificationPath", () => {
  it("joins distinct category and classification names", () => {
    expect(buildClassificationPath("الرعاية الصحية", "طلب خدمة")).toBe(
      "الرعاية الصحية / طلب خدمة"
    );
  });

  it("collapses equal names to a single label", () => {
    expect(buildClassificationPath("طلب خدمة", "طلب خدمة")).toBe("طلب خدمة");
  });

  it("supports duplicate sub-names under different categories", () => {
    expect(buildClassificationPath("شؤون النزلاء", "طلب خدمة")).toBe(
      "شؤون النزلاء / طلب خدمة"
    );
    expect(buildClassificationPath("الرعاية الصحية", "طلب خدمة")).not.toBe(
      buildClassificationPath("شؤون النزلاء", "طلب خدمة")
    );
  });

  it("falls back to unclassified when both names are empty", () => {
    expect(buildClassificationPath(null, null)).toBe(UNCLASSIFIED_CLASSIFICATION_LABEL);
    expect(classificationDisplayName(null)).toBe(UNCLASSIFIED_CLASSIFICATION_LABEL);
  });
});
