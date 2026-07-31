// @vitest-environment node
import { describe, expect, it } from "vitest";
import { escapeXml } from "./report-chart-service";

describe("escapeXml", () => {
  it("escapes all five XML/SVG special characters", () => {
    expect(escapeXml('& < > " \'')).toBe("&amp; &lt; &gt; &quot; &apos;");
  });

  it("does not double-escape already-escaped entities", () => {
    // '&amp;' must NOT become '&amp;amp;'
    expect(escapeXml("a & b")).toBe("a &amp; b");
    expect(escapeXml("&amp;")).toBe("&amp;amp;"); // raw text that looks like an entity
  });

  it("leaves Arabic text and digits unchanged", () => {
    const arabic = "منطقة الرياض 123";
    expect(escapeXml(arabic)).toBe(arabic);
  });

  it("handles an empty string", () => {
    expect(escapeXml("")).toBe("");
  });

  it("escapes all occurrences, not just the first", () => {
    expect(escapeXml("a & b & c")).toBe("a &amp; b &amp; c");
    expect(escapeXml("<<>>")).toBe("&lt;&lt;&gt;&gt;");
  });
});
