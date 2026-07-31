import { describe, it, expect } from "vitest";
import { sanitizeText, sanitizeComplaint, buildAggregateStats, detectPII } from "./ai-data-sanitization-service";

describe("sanitizeText - PII redaction", () => {
  it("redacts Saudi national ID", () => {
    expect(sanitizeText("رقم الهوية 1234567890 في السجل")).not.toContain("1234567890");
    expect(detectPII("1234567890")).toContain("NATIONAL_ID");
  });

  it("redacts phone numbers", () => {
    const inputs = ["+966501234567", "0501234567", "00966501234567"];
    for (const phone of inputs) {
      expect(detectPII(phone).length).toBeGreaterThan(0);
      expect(sanitizeText(phone)).not.toContain(phone);
    }
  });

  it("redacts email addresses", () => {
    const text = "تواصل معنا على user@example.com للمساعدة";
    expect(sanitizeText(text)).not.toContain("user@example.com");
    expect(detectPII("user@example.com")).toContain("EMAIL");
  });

  it("redacts URLs", () => {
    const text = "زر الموقع https://example.com/profile?id=123";
    expect(sanitizeText(text)).not.toContain("https://example.com");
    expect(detectPII("https://example.com")).toContain("URL");
  });

  it("does not redact Arabic department names", () => {
    const text = "قسم الموارد البشرية";
    expect(sanitizeText(text)).toContain("قسم الموارد البشرية");
  });

  it("does not redact normal Arabic text", () => {
    const text = "الشكوى تتعلق بجودة الخدمة الطبية";
    expect(sanitizeText(text)).toBe(text);
  });

  it("keeps text length within bounds for long inputs", () => {
    const long = "ا".repeat(10000);
    expect(sanitizeText(long).length).toBeLessThanOrEqual(10001);
  });
});

describe("sanitizeComplaint", () => {
  it("removes complainant name and identifier", () => {
    const c = {
      id: "abc",
      subject: "شكوى من محمد عبدالله بشأن الخدمة",
      description: "يشكو المواطن 1234567890 من التأخر",
      complainantName: "محمد عبدالله",
      complainantIdentifier: "1234567890",
    };
    const result = sanitizeComplaint(c);
    expect(result).not.toHaveProperty("complainantName");
    expect(result).not.toHaveProperty("complainantIdentifier");
    expect(result.description).not.toContain("1234567890");
  });

  it("truncates long descriptions to 500 chars", () => {
    const c = { id: "x", subject: "شكوى", description: "أ".repeat(1000) };
    const result = sanitizeComplaint(c);
    expect(result.description?.length).toBeLessThanOrEqual(500);
  });

  it("computes isOverdue correctly", () => {
    const past = new Date(Date.now() - 86400000 * 2).toISOString();
    const future = new Date(Date.now() + 86400000 * 2).toISOString();
    expect(sanitizeComplaint({ id: "1", subject: "s", dueDate: past }).isOverdue).toBe(true);
    expect(sanitizeComplaint({ id: "2", subject: "s", dueDate: future }).isOverdue).toBe(false);
  });
});

describe("buildAggregateStats", () => {
  it("counts by department correctly", () => {
    const complaints = [
      { id: "1", subject: "s", department: "A" },
      { id: "2", subject: "s", department: "A" },
      { id: "3", subject: "s", department: "B" },
    ];
    const stats = buildAggregateStats(complaints);
    expect(stats.byDepartment["A"]).toBe(2);
    expect(stats.byDepartment["B"]).toBe(1);
    expect(stats.totalComplaints).toBe(3);
  });

  it("counts overdue correctly", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const complaints = [
      { id: "1", subject: "s", dueDate: past },
      { id: "2", subject: "s" },
    ];
    const stats = buildAggregateStats(complaints);
    expect(stats.overdueCount).toBe(1);
  });
});

describe("PII detection integration", () => {
  it("detects multiple PII types in a single text", () => {
    const text = "يتصل بنا على 0501234567 أو user@email.com";
    const found = detectPII(text);
    expect(found).toContain("PHONE");
    expect(found).toContain("EMAIL");
  });

  it("returns empty array for clean text", () => {
    expect(detectPII("تأخر في الرد على الشكوى")).toEqual([]);
  });
});

describe("sanitizeText — input length cap", () => {
  it("throws for inputs exceeding MAX_SANITIZATION_INPUT_LENGTH", () => {
    const oversized = "أ".repeat(100_001);
    expect(() => sanitizeText(oversized)).toThrow(/exceeds maximum length/);
  });

  it("accepts inputs at exactly the limit", () => {
    const atLimit = "ا".repeat(100_000);
    expect(() => sanitizeText(atLimit)).not.toThrow();
  });
});

describe("CARD regex — correctness and ReDoS safety", () => {
  it("redacts a standard 16-digit card number", () => {
    const text = "البطاقة 4111111111111111 المدفوعة";
    expect(sanitizeText(text)).not.toContain("4111111111111111");
  });

  it("redacts a card number with spaces", () => {
    const text = "رقم البطاقة 4111 1111 1111 1111";
    expect(sanitizeText(text)).not.toContain("4111 1111 1111 1111");
  });

  it("redacts a card number with dashes", () => {
    const text = "4111-1111-1111-1111";
    expect(sanitizeText(text)).not.toContain("4111-1111-1111-1111");
  });

  it("does not catastrophically backtrack on malicious input", () => {
    // Input designed to trigger exponential backtracking in naive range-quantifier patterns
    const malicious = "1234 1234 1234 123" + "x".repeat(30);
    const start = Date.now();
    sanitizeText(malicious);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // must complete well under 100ms
  });
});
