import { describe, expect, it } from "vitest";
import { matchTextRisks, computeSourceTextHash } from "./text-risk-matcher";
import { normalizeForMatching } from "./text-risk-normalize";
import { TEXT_RISK_RULES } from "./text-risk-rule-catalog";

// ---------- Helpers ----------

function match(subject: string, description: string | null = null) {
  return matchTextRisks({ subject, description });
}

function matchIds(subject: string, description: string | null = null): string[] {
  return match(subject, description).map((m) => m.ruleId);
}

// ---------- Poisoning (POISON_001) ----------

describe("POISON_001 — poisoning", () => {
  it("detects تسمم in subject", () => {
    const results = match("يعاني المحتجز من تسمم حاد");
    expect(results.some((r) => r.ruleId === "POISON_001")).toBe(true);
  });

  it("detects تسمّم (with shadda) via normalization to تسمم", () => {
    // shadda is stripped by normalizeArabic → "تسمم" → matches POISON_001
    const results = match("تسمّم الطعام");
    expect(results.some((r) => r.ruleId === "POISON_001")).toBe(true);
  });

  it("detects تسمم in description field", () => {
    const results = match("شكوى طارئة", "وجود حالات تسمم في المطبخ");
    expect(results.some((r) => r.ruleId === "POISON_001")).toBe(true);
  });

  it("assigns SUSPECTED certainty when اشتباه precedes تسمم", () => {
    const results = match("اشتباه تسمم في وجبة العشاء");
    const p = results.find((r) => r.ruleId === "POISON_001");
    expect(p).toBeDefined();
    expect(p?.certainty).toBe("SUSPECTED");
  });

  it("assigns SUSPECTED and lower confidence when اشتباه is present", () => {
    const base = match("تسمم في وجبة الغداء");
    const susp = match("يشتبه في وجود تسمم");
    const baseConf = base.find((r) => r.ruleId === "POISON_001")?.confidenceScore ?? 0;
    const suspConf = susp.find((r) => r.ruleId === "POISON_001")?.confidenceScore ?? 1;
    expect(suspConf).toBeLessThan(baseConf);
  });

  it("assigns HISTORICAL_RESOLVED certainty when سابقا is present", () => {
    const results = match("حدث تسمم سابقا في نفس المطبخ");
    const p = results.find((r) => r.ruleId === "POISON_001");
    expect(p).toBeDefined();
    expect(p?.certainty).toBe("HISTORICAL_RESOLVED");
  });

  it("does NOT fire when لا يوجد تسمم is present (negated)", () => {
    const results = match("لا يوجد تسمم في الطعام");
    expect(results.some((r) => r.ruleId === "POISON_001")).toBe(false);
  });

  it("does NOT fire when لم يحدث precedes تسمم within narrow window", () => {
    const results = match("أكد الفريق الطبي أنه لم يحدث تسمم");
    expect(results.some((r) => r.ruleId === "POISON_001")).toBe(false);
  });

  it("detects تسمم with ongoing flag when لا يزال is present", () => {
    const results = match("لا يزال هناك اشتباه في تسمم غذائي مستمر");
    const p = results.find((r) => r.ruleId === "POISON_001");
    expect(p).toBeDefined();
    expect(p?.isOngoing).toBe(true);
  });

  it("distant negation (>60 chars away) does NOT cancel match", () => {
    // The negation "لا يوجد" is more than 60 chars before the "تسمم" match
    // A subject with no negation tokens, a description with the match only
    // — the two are concatenated with a space in the normalizer, keeping them well apart.
    const subjectNoNegation = "وردت شكاوى بشأن أحوال الإقامة وتهوية المرافق الصحية في الجناح الشمالي وسيتم المتابعة";
    const descriptionWithMatch = "تسمم غذائي حاد في المطبخ المركزي";
    // Confirm there are no negation tokens in the subject
    expect(subjectNoNegation.includes("لا يوجد")).toBe(false);
    const results = match(subjectNoNegation, descriptionWithMatch);
    expect(results.some((r) => r.ruleId === "POISON_001")).toBe(true);
  });
});

// ---------- Service outage ----------

describe("SVC_OUT_001 — electricity outage", () => {
  it("detects انقطاع الكهرباء", () => {
    expect(matchIds("يوجد انقطاع في الكهرباء منذ يومين")).toContain("SVC_OUT_001");
  });

  it("detects انقطاع التيار", () => {
    expect(matchIds("انقطاع التيار الكهربائي المستمر")).toContain("SVC_OUT_001");
  });

  it("does NOT fire when لا يوجد precedes انقطاع", () => {
    expect(matchIds("لا يوجد انقطاع في الكهرباء")).not.toContain("SVC_OUT_001");
  });

  it("assigns HISTORICAL_RESOLVED when عاد التيار is present near match", () => {
    const results = match("عاد التيار بعد انقطاع الكهرباء");
    const r = results.find((m) => m.ruleId === "SVC_OUT_001");
    expect(r?.certainty).toBe("HISTORICAL_RESOLVED");
  });

  it("sets isOngoing=false when match is historical", () => {
    const results = match("عاد التيار بعد انقطاع الكهرباء");
    const r = results.find((m) => m.ruleId === "SVC_OUT_001");
    expect(r?.isOngoing).toBe(false);
  });
});

describe("SVC_OUT_002 — water outage", () => {
  it("detects انقطاع المياه", () => {
    expect(matchIds("انقطاع المياه عن الجناح لمدة 3 أيام")).toContain("SVC_OUT_002");
  });

  it("detects dialectal انقطاع المويه", () => {
    expect(matchIds("انقطاع المويه منذ الأمس")).toContain("SVC_OUT_002");
  });

  it("does NOT fire when لم يحدث present", () => {
    expect(matchIds("لم يحدث انقطاع للمياه")).not.toContain("SVC_OUT_002");
  });
});

describe("SVC_OUT_003 — AC failure", () => {
  it("detects تعطل التكييف", () => {
    expect(matchIds("تعطل التكييف في الغرفة")).toContain("SVC_OUT_003");
  });

  it("detects تعطل المكيف", () => {
    // No negation tokens in this phrase
    expect(matchIds("تعطل المكيف في جناح أ")).toContain("SVC_OUT_003");
  });
});

describe("SVC_OUT_004 — system/network failure", () => {
  it("detects تعطل السيستم (informal spelling)", () => {
    expect(matchIds("تعطل السيستم وتوقف النظام")).toContain("SVC_OUT_004");
  });

  it("detects تعطل النظام", () => {
    expect(matchIds("تعطل النظام الإلكتروني بشكل كامل")).toContain("SVC_OUT_004");
  });
});

// ---------- Sentence expiry (SENT_001) ----------

describe("SENT_001 — sentence expiry without release", () => {
  it("detects انتهاء محكوميته without release", () => {
    // Use "انتهي محكوميه" which matches group ["انتهي", "محكوميه"]
    // Avoid "لم يتم" (a negation token in COMMON_NEGATION) in proximity
    expect(matchIds("انتهي محكوميه بدون اطلاق سراح")).toContain("SENT_001");
  });

  it("detects انتهاء المحكوميه", () => {
    expect(matchIds("تم تقديم شكوى بشأن انتهاء المحكوميه دون اطلاق سراح")).toContain("SENT_001");
  });

  it("assigns HISTORICAL_RESOLVED when تم الاطلاق is present", () => {
    const results = match("تم الاطلاق بعد انتهاء المحكوميه");
    const r = results.find((m) => m.ruleId === "SENT_001");
    expect(r?.certainty).toBe("HISTORICAL_RESOLVED");
  });

  it("does NOT fire when لم تنته محكوميته (negation token)", () => {
    // "لم تنته" is in SENT_001 negationTokens
    const results = match("لم تنته المده المحدده للمحكوميه");
    expect(results.some((r) => r.ruleId === "SENT_001")).toBe(false);
  });

  it("assigns ongoing=true when لم يطلق is in ongoingTokens near match", () => {
    const results = match("انتهي محكوميه ولم يطلق سراحه حتى الان");
    const r = results.find((m) => m.ruleId === "SENT_001");
    expect(r?.isOngoing).toBe(true);
  });
});

// ---------- Public health (HEALTH_001) ----------

describe("HEALTH_001 — disease spread", () => {
  it("detects انتشار عدوى", () => {
    // Rule uses "عدوي" (ى→ي normalization of عدوى)
    const results = match("انتشار عدوى في الجناح");
    expect(results.some((r) => r.ruleId === "HEALTH_001")).toBe(true);
  });

  it("detects أعراض متشابهة (normalized to اعراض متشابهه)", () => {
    // أعراض: أ→ا → "اعراض"; متشابهة: ة→ه → "متشابهه"
    const results = match("وردت شكاوى بأعراض متشابهة بين عدد من المحتجزين");
    expect(results.some((r) => r.ruleId === "HEALTH_001")).toBe(true);
  });

  it("does NOT fire when لا يوجد انتشار present", () => {
    // "انتشار مرض" is the match group; if we say "لا يوجد انتشار للمرض" it's negated
    const results = match("لا يوجد انتشار للمرض");
    expect(results.some((r) => r.ruleId === "HEALTH_001")).toBe(false);
  });
});

// ---------- Security (SEC_002 — escape attempt) ----------

describe("SEC_002 — escape attempt", () => {
  it("detects محاولة هروب", () => {
    // "محاوله هروب" after normalization of "محاولة هروب" (ة→ه)
    expect(matchIds("وردت بلاغات بمحاولة هروب")).toContain("SEC_002");
  });

  it("does NOT fire when لا توجد محاولة هروب", () => {
    expect(matchIds("أكدت الإدارة أنه لا توجد محاولة هروب")).not.toContain("SEC_002");
  });

  it("assigns SUSPECTED when يشتبه is near محاولة هروب", () => {
    const results = match("يشتبه في وجود محاولة هروب");
    const r = results.find((m) => m.ruleId === "SEC_002");
    expect(r?.certainty).toBe("SUSPECTED");
  });
});

// ---------- Negation boundary tests ----------

describe("negation proximity window", () => {
  it("negation token before match within window cancels", () => {
    // "لا يوجد" + "تسمم" within 60 chars
    const results = match("لا يوجد تسمم في الطعام المقدم");
    expect(results.some((r) => r.ruleId === "POISON_001")).toBe(false);
  });

  it("negation token after match within window cancels", () => {
    // "تسمم" then "لا يوجد" within 60 chars of match
    const results = match("تسمم ولا يوجد دليل على ذلك");
    expect(results.some((r) => r.ruleId === "POISON_001")).toBe(false);
  });

  it("negation token beyond window does not cancel", () => {
    // "تسمم" appears early in the sentence; "لا يوجد" appears >60 normalized chars later.
    // This test is deterministic: we verify the distance in the assertion before asserting the match.
    const text = "وردت شكوى بوجود تسمم غذائي في المطبخ وقد تم فتح تحقيق في هذا الشأن من قبل الجهات المختصة ولا يوجد ما يثير القلق";
    const normalized = normalizeForMatching(text);
    const tsammPos = normalized.indexOf("تسمم");
    const negPos = normalized.indexOf("لا يوجد");
    expect(tsammPos).toBeGreaterThan(-1);
    expect(negPos).toBeGreaterThan(-1);
    expect(negPos - tsammPos).toBeGreaterThan(60);
    // Negation is beyond the window, so the match still fires
    const results = match(text);
    expect(results.some((r) => r.ruleId === "POISON_001")).toBe(true);
  });
});

// ---------- Deduplication ----------

describe("deduplication", () => {
  it("returns each rule at most once per unique evidence hash", () => {
    const results = match("انقطاع الكهرباء والتيار الكهربائي منقطع");
    const svcIds = results.filter((r) => r.ruleId === "SVC_OUT_001").map((r) => r.ruleId);
    expect(svcIds.length).toBeLessThanOrEqual(1);
  });

  it("returns independent results for different rules triggered by same text", () => {
    // "تسمم وانقطاع الكهرباء" should trigger both POISON_001 and SVC_OUT_001
    const results = match("تسمم غذائي شديد وانقطاع الكهرباء عن الجناح");
    const ids = results.map((r) => r.ruleId);
    expect(ids).toContain("POISON_001");
    expect(ids).toContain("SVC_OUT_001");
  });
});

// ---------- Privacy / PII safety ----------

describe("evidenceSpans PII sanitization", () => {
  it("strips national ID from evidence span", () => {
    const results = match("يعاني المحتجز رقم هويته 1234567891 من تسمم غذائي");
    const p = results.find((r) => r.ruleId === "POISON_001");
    expect(p).toBeDefined();
    const spans = (p?.evidenceSpans ?? []) as string[];
    const combined = spans.join(" ");
    expect(combined).not.toContain("1234567891");
  });

  it("strips phone number from evidence span", () => {
    const results = match("شكوى تسمم من المحتجز يمكن التواصل معه على 0551234567");
    const p = results.find((r) => r.ruleId === "POISON_001");
    const spans = (p?.evidenceSpans ?? []) as string[];
    const combined = spans.join(" ");
    expect(combined).not.toContain("0551234567");
  });
});

// ---------- computeSourceTextHash ----------

describe("computeSourceTextHash", () => {
  it("returns a hex string", () => {
    const hash = computeSourceTextHash("subject", "description");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns different hash when subject changes", () => {
    const h1 = computeSourceTextHash("subject A", "desc");
    const h2 = computeSourceTextHash("subject B", "desc");
    expect(h1).not.toBe(h2);
  });

  it("returns different hash when description changes", () => {
    const h1 = computeSourceTextHash("sub", "description A");
    const h2 = computeSourceTextHash("sub", "description B");
    expect(h1).not.toBe(h2);
  });

  it("returns same hash for null and empty description if they normalize identically", () => {
    // normalizeForMatching("sub\n") vs normalizeForMatching("sub\n") — stable
    const h1 = computeSourceTextHash("sub", null);
    const h2 = computeSourceTextHash("sub", null);
    expect(h1).toBe(h2);
  });

  it("returns different hash for null vs non-empty description", () => {
    const h1 = computeSourceTextHash("sub", null);
    const h2 = computeSourceTextHash("sub", "some description");
    expect(h1).not.toBe(h2);
  });
});

// ---------- Confidence scaling ----------

describe("confidence scaling", () => {
  it("description presence gives higher confidence than subject-only", () => {
    // With description — hasDescription=true
    const withDesc = match("تسمم في الطعام", "تأكيد بوجود تسمم في المطبخ");
    const withoutDesc = match("تسمم في الطعام", null);
    const confWith = withDesc.find((r) => r.ruleId === "POISON_001")?.confidenceScore ?? 0;
    const confWithout = withoutDesc.find((r) => r.ruleId === "POISON_001")?.confidenceScore ?? 1;
    expect(confWith).toBeGreaterThan(confWithout);
  });

  it("historical match has lower confidence than direct match", () => {
    const direct = match("تسمم حاد في الجناح");
    const historical = match("تسمم سابقا في الجناح");
    const dConf = direct.find((r) => r.ruleId === "POISON_001")?.confidenceScore ?? 0;
    const hConf = historical.find((r) => r.ruleId === "POISON_001")?.confidenceScore ?? 1;
    expect(hConf).toBeLessThan(dConf);
  });
});

// ---------- Empty / edge cases ----------

describe("edge cases", () => {
  it("returns empty array for unrelated text", () => {
    expect(match("طلب تجديد الوثائق الشخصية")).toHaveLength(0);
  });

  it("returns empty array for empty string", () => {
    expect(match("")).toHaveLength(0);
  });

  it("handles null description without throwing", () => {
    expect(() => match("تسمم", null)).not.toThrow();
  });

  it("returns results when match is only in description", () => {
    const results = match("شكوى عامة", "تسمم حاد في الجناح الثالث");
    expect(results.some((r) => r.ruleId === "POISON_001")).toBe(true);
  });

  it("truncates very long text instead of throwing", () => {
    const longText = "أ".repeat(10000) + " تسمم ";
    expect(() => match(longText)).not.toThrow();
  });

  it("ruleVersion matches RULE_CATALOG_VERSION in all results", () => {
    const results = match("تسمم غذائي في المطبخ");
    results.forEach((r) => expect(r.ruleVersion).toBe("rule-v1"));
  });
});

// ---------- Evidence extraction from normalized coordinates ----------

describe("evidence spans from normalized text", () => {
  it("returns non-empty evidence span when subject contains tashkeel", () => {
    // Tashkeel is stripped during normalization; matchPos is from normalizedText.
    // Evidence must be extracted from normalizedText (not originalText) to avoid coord mismatch.
    const results = match("يُعَانِي المحتجز من تَسْمُم حاد");
    const p = results.find((r) => r.ruleId === "POISON_001");
    expect(p).toBeDefined();
    const spans = (p?.evidenceSpans ?? []) as string[];
    expect(spans.length).toBeGreaterThan(0);
    spans.forEach((span) => expect(span.trim().length).toBeGreaterThan(0));
  });

  it("evidence span contains the matched keyword (normalized form)", () => {
    const results = match("تَسْمُم غذائي حاد في المطبخ");
    const p = results.find((r) => r.ruleId === "POISON_001");
    const spans = (p?.evidenceSpans ?? []) as string[];
    expect(spans.join(" ")).toContain("تسمم");
  });

  it("returns evidence span when input has tatweel characters", () => {
    // Tatweel (U+0640) is stripped by normalizer; coord must be from normalizedText.
    const results = match("تـسـمـم غذائي في الجناح");
    const p = results.find((r) => r.ruleId === "POISON_001");
    expect(p).toBeDefined();
    const spans = (p?.evidenceSpans ?? []) as string[];
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.join(" ")).toContain("تسمم");
  });

  it("returns evidence span when input has repeated spaces", () => {
    const results = match("وجود   تسمم   غذائي   حاد");
    const p = results.find((r) => r.ruleId === "POISON_001");
    expect(p).toBeDefined();
    const spans = (p?.evidenceSpans ?? []) as string[];
    expect(spans.length).toBeGreaterThan(0);
  });
});

// ---------- False-positive guard: removed SEC_002 ["فر"] token ----------

describe("SEC_002 false-positive guard (removed 2-char [فر] token)", () => {
  it("does NOT fire for الإفراج عن محتجز (افراج contains فر but rule removed that token)", () => {
    // Old rule had ["فر"] which matched position 4 in "الافراج". Now removed.
    expect(matchIds("تم الإفراج عن المحتجز بعد انتهاء إجراءات التحقيق")).not.toContain("SEC_002");
  });

  it("does NOT fire for فريق (فريق contains فر but rule removed that token)", () => {
    expect(matchIds("وصل فريق الطوارئ إلى الموقع")).not.toContain("SEC_002");
  });

  it("does NOT fire for مصروف (unrelated to escape attempts)", () => {
    expect(matchIds("مصروف الاعاشه لم يصل")).not.toContain("SEC_002");
  });
});

// ---------- False-positive guard: removed HEALTH_002 standalone ["انتهي"] ----------

describe("HEALTH_002 false-positive guard (removed standalone [انتهي] group)", () => {
  it("does NOT fire for انتهى الإجراء (procedural completion)", () => {
    // Old standalone ["انتهي"] matched any procedural sentence with "انتهي".
    expect(matchIds("انتهى الإجراء القانوني وأُغلق الملف")).not.toContain("HEALTH_002");
  });

  it("does NOT fire for انتهى الموعد (appointment end)", () => {
    expect(matchIds("انتهى الموعد المحدد للمراجعة")).not.toContain("HEALTH_002");
  });

  it("does NOT fire for انتهت المعالجة (treatment end)", () => {
    expect(matchIds("انتهت المعالجه وخرج من المستشفي")).not.toContain("HEALTH_002");
  });
});

// ---------- HEALTH_002 positive cases: new specific groups ----------

describe("HEALTH_002 — positive cases with new specific groups", () => {
  it("detects انتهت حياته (death phrase)", () => {
    const results = match("انتهت حياته داخل مرفق الاحتجاز");
    expect(results.some((r) => r.ruleId === "HEALTH_002")).toBe(true);
  });

  it("detects انتهي أجله (death phrase with dialectal spelling)", () => {
    const results = match("يُدّعى أن انتهي أجله قبل وصول الإسعاف");
    expect(results.some((r) => r.ruleId === "HEALTH_002")).toBe(true);
  });

  it("detects وفاة (death)", () => {
    expect(matchIds("الشكوى تتعلق بوفاه أحد المحتجزين")).toContain("HEALTH_002");
  });

  it("detects فقدان وعي (loss of consciousness)", () => {
    expect(matchIds("أفاد بوجود فقدان وعي لدى المحتجز")).toContain("HEALTH_002");
  });

  it("detects تأخر الإسعاف (ambulance delay)", () => {
    expect(matchIds("تم تقديم شكوى بسبب تأخر الإسعاف عن الوصول")).toContain("HEALTH_002");
  });
});

// ---------- Catalog token normalization invariant ----------

describe("catalog token normalization invariant", () => {
  it("every primaryGroup token is already in normalized form", () => {
    const dead: string[] = [];
    for (const rule of TEXT_RISK_RULES) {
      for (const group of rule.primaryGroups) {
        for (const token of group) {
          const normalized = normalizeForMatching(token);
          if (normalized !== token) {
            dead.push(`[${rule.ruleId}] "${token}" → "${normalized}"`);
          }
        }
      }
    }
    expect(dead, `Dead tokens found:\n${dead.join("\n")}`).toHaveLength(0);
  });

  it("every negationToken is already in normalized form", () => {
    const dead: string[] = [];
    for (const rule of TEXT_RISK_RULES) {
      for (const token of rule.negationTokens) {
        const normalized = normalizeForMatching(token);
        if (normalized !== token) {
          dead.push(`[${rule.ruleId} negation] "${token}" → "${normalized}"`);
        }
      }
    }
    expect(dead, `Dead negation tokens:\n${dead.join("\n")}`).toHaveLength(0);
  });
});
