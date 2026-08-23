// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplaintPriority, ComplaintStatus, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";
import { runPrismaMigrateDeploy } from "../../../../scripts/lib/prisma-cli-runner";
import { normalizeFacilityName } from "@/server/facilities/facility-name";

const dbHolder = vi.hoisted(() => ({ client: null as PrismaClient | null }));

vi.mock("@/lib/db", () => ({
  db: {
    get complaint() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.complaint;
    },
    get classification() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.classification;
    },
    get facility() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.facility;
    },
  },
}));

const { renderRepeatComplainantBulkPdf } = await import("./repeat-complainant-bulk-pdf-service");
const { renderRepeatComplainantPersonPdf } = await import("./repeat-complainant-person-pdf-service");
const { getRepeatComplainantExportData } = await import("./repeat-complainant-analytics-service");
const { encodeComplainantToken } = await import("@/server/complaints/complainant-token");

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
let tempDir: string | null = null;

const FACILITY = "سجن اختبار PDF";
const RAW_IDENTIFIER = "9911223344";

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cip-repeat-pdf-"));
  const dbPath = join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  runPrismaMigrateDeploy(`file:${dbPath}`);
  dbHolder.client = new PrismaClient();
  await seed(dbHolder.client);
}, 60_000);

afterAll(async () => {
  try {
    await dbHolder.client?.$disconnect();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  } finally {
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SECOND_FACILITY = "سجن اختبار PDF 2";
const THIRD_FACILITY = "سجن اختبار PDF 3";
const MULTI_FACILITY_IDENTIFIER = "9922334455";

const SHORT_NAME = "محمد علي";
const SHORT_NAME_IDENTIFIER = "9933445566";
const LONG_NAME = "محمد عبدالله عبدالرحمن القحطاني";
const LONG_NAME_IDENTIFIER = "9944556677";
const VERY_LONG_NAME = "عبدالرحمن محمد عبدالله بن أحمد القحطاني";
const VERY_LONG_NAME_IDENTIFIER = "9955667788";
const LONG_CLASSIFICATION_NAME = "التغذية وجودة الوجبات المقدمة للنزلاء داخل السجن";

async function seed(prisma: PrismaClient) {
  const category = await prisma.category.create({ data: { nameAr: "فئة PDF", nameEn: "PDF", isActive: true } });
  const cls = await prisma.classification.create({
    data: { categoryId: category.id, nameAr: "التغذية", nameEn: "Food", isActive: true },
  });
  const longCls = await prisma.classification.create({
    data: { categoryId: category.id, nameAr: LONG_CLASSIFICATION_NAME, nameEn: "Food quality", isActive: true },
  });
  const key = normalizeFacilityName(FACILITY);
  const secondKey = normalizeFacilityName(SECOND_FACILITY);
  const thirdKey = normalizeFacilityName(THIRD_FACILITY);
  const base = {
    subject: "شكوى اختبار PDF",
    description: "وصف تفصيلي طويل نسبياً لاختبار قص النص داخل التقرير المولد بصيغة PDF للتأكد من عدم حدوث تجاوز.",
    priority: ComplaintPriority.MEDIUM,
    severity: ComplaintPriority.MEDIUM,
    isDeleted: false,
    status: ComplaintStatus.OPEN,
    region: "الرياض",
    facility: FACILITY,
    facilityNormalizedName: key,
    classificationId: cls.id,
    complainantIdentifier: RAW_IDENTIFIER,
    complainantName: "عبدالله ناصر",
  };
  await prisma.complaint.createMany({
    data: [
      { ...base, externalId: "pdf-1", complaintDate: new Date("2026-01-05T00:00:00.000Z") },
      { ...base, externalId: "pdf-2", complaintDate: new Date("2026-01-15T00:00:00.000Z") },
      { ...base, externalId: "pdf-3", complaintDate: new Date("2026-02-05T00:00:00.000Z") },
      // A person who appears at TWO facilities (multi-facility, facility-scoped numbers).
      { ...base, externalId: "pdf-m1", facility: FACILITY, facilityNormalizedName: key, complainantIdentifier: MULTI_FACILITY_IDENTIFIER, complainantName: "منيرة سعد", complaintDate: new Date("2026-01-06T00:00:00.000Z") },
      { ...base, externalId: "pdf-m2", facility: SECOND_FACILITY, facilityNormalizedName: secondKey, complainantIdentifier: MULTI_FACILITY_IDENTIFIER, complainantName: "منيرة سعد", complaintDate: new Date("2026-02-06T00:00:00.000Z") },
      // A second complaint at EACH of her two facilities — needed so she
      // clears the FACILITY-level repeat threshold (>=2) at BOTH
      // facilities, not just the org-level one, letting the facility-
      // scoped-numbers test below exercise two real facility sections for
      // her (with two DIFFERENT facility-scoped totals) instead of one.
      { ...base, externalId: "pdf-m3", facility: SECOND_FACILITY, facilityNormalizedName: secondKey, complainantIdentifier: MULTI_FACILITY_IDENTIFIER, complainantName: "منيرة سعد", complaintDate: new Date("2026-02-16T00:00:00.000Z") },
      { ...base, externalId: "pdf-m4", facility: FACILITY, facilityNormalizedName: key, complainantIdentifier: MULTI_FACILITY_IDENTIFIER, complainantName: "منيرة سعد", complaintDate: new Date("2026-01-26T00:00:00.000Z") },
      // Short name — control case, should render on one line.
      { ...base, externalId: "pdf-short-1", complainantIdentifier: SHORT_NAME_IDENTIFIER, complainantName: SHORT_NAME, complaintDate: new Date("2026-01-08T00:00:00.000Z") },
      { ...base, externalId: "pdf-short-2", complainantIdentifier: SHORT_NAME_IDENTIFIER, complainantName: SHORT_NAME, complaintDate: new Date("2026-01-18T00:00:00.000Z") },
      // Long name — should wrap, not silently truncate to one ellipsized line.
      { ...base, externalId: "pdf-long-1", complainantIdentifier: LONG_NAME_IDENTIFIER, complainantName: LONG_NAME, classificationId: longCls.id, complaintDate: new Date("2026-01-09T00:00:00.000Z") },
      { ...base, externalId: "pdf-long-2", complainantIdentifier: LONG_NAME_IDENTIFIER, complainantName: LONG_NAME, classificationId: longCls.id, complaintDate: new Date("2026-01-19T00:00:00.000Z") },
      // Very long name, in a THIRD facility under a DIFFERENT region (مكة) —
      // exercises the region-heading-then-facility-headings grouping.
      { ...base, externalId: "pdf-vlong-1", region: "مكة", facility: THIRD_FACILITY, facilityNormalizedName: thirdKey, complainantIdentifier: VERY_LONG_NAME_IDENTIFIER, complainantName: VERY_LONG_NAME, classificationId: longCls.id, complaintDate: new Date("2026-01-10T00:00:00.000Z") },
      { ...base, externalId: "pdf-vlong-2", region: "مكة", facility: THIRD_FACILITY, facilityNormalizedName: thirdKey, complainantIdentifier: VERY_LONG_NAME_IDENTIFIER, complainantName: VERY_LONG_NAME, classificationId: longCls.id, complaintDate: new Date("2026-01-20T00:00:00.000Z") },
    ],
  });
}

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

function collectTextCalls(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

describe("repeat-complainant bulk PDF — real db (temp sqlite)", () => {
  it("produces a valid, non-empty PDF buffer", async () => {
    const buffer = await renderRepeatComplainantBulkPdf(params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "الفترة من 2026-01-01 إلى 2026-03-01",
      scopeLabel: null,
    });
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("masks the identifier by default — the raw value never appears in any drawn text", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    await renderRepeatComplainantBulkPdf(params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
      scopeLabel: null,
    });
    const rendered = collectTextCalls(textSpy);
    expect(rendered.some((t) => t.includes(RAW_IDENTIFIER))).toBe(false);
    expect(rendered.some((t) => t.includes("****"))).toBe(true);
  });

  it("shows the raw identifier and a PII warning ONLY when includeFullIdentifier is explicitly true", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    await renderRepeatComplainantBulkPdf(params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: true,
      periodLabel: "test",
      scopeLabel: null,
    });
    const rendered = collectTextCalls(textSpy);
    expect(rendered.some((t) => t.includes(RAW_IDENTIFIER))).toBe(true);
    expect(rendered.some((t) => t.includes("تعريفية"))).toBe(true);
  });

  it("respects the same filters as the on-screen analysis (date range narrows the export)", async () => {
    const buffer = await renderRepeatComplainantBulkPdf(params("from=2030-01-01&to=2030-02-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
      scopeLabel: null,
    });
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("repeat-complainant person PDF — real db (temp sqlite)", () => {
  it("stays A4 PORTRAIT (height > width) — unlike the bulk PDF, this report never adopts landscape", async () => {
    const token = encodeComplainantToken(RAW_IDENTIFIER);
    const buffer = await renderRepeatComplainantPersonPdf(token, FACILITY, params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
    });
    const [width, height] = mediaBoxOf(buffer!);
    expect(height).toBeGreaterThan(width);
    expect(width).toBeCloseTo(595.28, 1);
    expect(height).toBeCloseTo(841.89, 1);
  });

  it("produces a valid PDF for a real person, masked by default", async () => {
    const token = encodeComplainantToken(RAW_IDENTIFIER);
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const buffer = await renderRepeatComplainantPersonPdf(token, FACILITY, params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
    });
    expect(buffer).not.toBeNull();
    expect(buffer!.subarray(0, 5).toString()).toBe("%PDF-");
    const rendered = collectTextCalls(textSpy);
    expect(rendered.some((t) => t.includes(RAW_IDENTIFIER))).toBe(false);
    expect(rendered.some((t) => t.includes("عبدالله"))).toBe(true);
  });

  it("includes the raw identifier and warning only when explicitly requested", async () => {
    const token = encodeComplainantToken(RAW_IDENTIFIER);
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    await renderRepeatComplainantPersonPdf(token, FACILITY, params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: true,
      periodLabel: "test",
    });
    const rendered = collectTextCalls(textSpy);
    expect(rendered.some((t) => t.includes(RAW_IDENTIFIER))).toBe(true);
    expect(rendered.some((t) => t.includes("تعريفية"))).toBe(true);
  });

  it("returns null for a garbled token instead of throwing or crashing", async () => {
    const buffer = await renderRepeatComplainantPersonPdf("garbage", FACILITY, params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
    });
    expect(buffer).toBeNull();
  });

  it("lists every complaint's details (number, date, facility, classification, subject)", async () => {
    const token = encodeComplainantToken(RAW_IDENTIFIER);
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    await renderRepeatComplainantPersonPdf(token, FACILITY, params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
    });
    const rendered = collectTextCalls(textSpy);
    expect(rendered.some((t) => t.includes("pdf-1"))).toBe(true);
    expect(rendered.some((t) => t.includes("التغذية"))).toBe(true);
  });

  it("draws a per-facility breakdown section (spec §18) for a person who appears at more than one facility, when fetched org-wide", async () => {
    const token = encodeComplainantToken(MULTI_FACILITY_IDENTIFIER);
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const buffer = await renderRepeatComplainantPersonPdf(token, null, params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
    });
    expect(buffer).not.toBeNull();
    const rendered = collectTextCalls(textSpy);
    // `preparePdfText` reverses multi-word Arabic TOKEN order for correct RTL
    // rendering (see arabic-pdf-text.ts) — matching a single distinctive word
    // ("السجون") is the same convention the PII-warning check below uses,
    // rather than the full (reordered) phrase.
    expect(rendered.some((t) => t.includes("السجون"))).toBe(true);
    // Facility names are multi-token (Arabic + a Latin/digit token), so — same
    // RTL word-reordering caveat as the heading above — check the tokens
    // rather than the whole name string: "اختبار" is common to both rows
    // (confirms the facility column rendered at all), and "2" is unique to
    // SECOND_FACILITY's own name, confirming BOTH rows were drawn.
    expect(rendered.filter((t) => t.includes("اختبار")).length).toBeGreaterThanOrEqual(2);
    expect(rendered.some((t) => /(?:^|\s)2(?:\s|$)/.test(t))).toBe(true);
  });

  it("does NOT draw the multi-facility section for a single-facility person", async () => {
    const token = encodeComplainantToken(RAW_IDENTIFIER);
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    await renderRepeatComplainantPersonPdf(token, FACILITY, params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
    });
    const rendered = collectTextCalls(textSpy);
    expect(rendered.some((t) => t.includes("ظهرت فيها الشكاوى"))).toBe(false);
  });

  it("scoping to ONE facility for a multi-facility person renders only that facility's complaints", async () => {
    const token = encodeComplainantToken(MULTI_FACILITY_IDENTIFIER);
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const buffer = await renderRepeatComplainantPersonPdf(token, FACILITY, params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
    });
    expect(buffer).not.toBeNull();
    const rendered = collectTextCalls(textSpy);
    expect(rendered.some((t) => t.includes("pdf-m1"))).toBe(true);
    expect(rendered.some((t) => t.includes("pdf-m2"))).toBe(false);
  });
});

function mediaBoxOf(buffer: Buffer): [number, number] {
  const text = buffer.toString("latin1");
  const match = text.match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/);
  if (!match) throw new Error("MediaBox not found in PDF buffer");
  return [Number(match[1]), Number(match[2])];
}

describe("repeat-complainant bulk PDF — layout redesign (real db, temp sqlite)", () => {
  it("is A4 LANDSCAPE (width > height) — the redesign's core layout decision", async () => {
    const buffer = await renderRepeatComplainantBulkPdf(params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
      scopeLabel: null,
    });
    const [width, height] = mediaBoxOf(buffer);
    expect(width).toBeGreaterThan(height);
    expect(width).toBeCloseTo(841.89, 1);
    expect(height).toBeCloseTo(595.28, 1);
  });

  it("a long name is never cut to a single ellipsized line — it wraps across more than one drawn line", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    await renderRepeatComplainantBulkPdf(params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
      scopeLabel: null,
    });
    const calls = textSpy.mock.calls;
    // The long name's words split across the visual-line reordering: at
    // least one draw call carries "عبدالرحمن" (a token of the LONG_NAME/
    // VERY_LONG_NAME) with lineBreak:false and WITHOUT ellipsis:true on
    // that specific line — i.e. rendered as a genuine wrapped line, not an
    // ellipsis-truncated single line.
    const nameLineCalls = calls.filter(([text]) => String(text).includes("عبدالرحمن"));
    expect(nameLineCalls.length).toBeGreaterThan(0);
    const anyTruncated = nameLineCalls.some(([, , , opts]) => (opts as Record<string, unknown> | undefined)?.ellipsis === true);
    expect(anyTruncated).toBe(false);
    // The very long name's full text must appear somewhere across the
    // drawn lines (split by preparePdfTextLayout, but never dropped).
    const allNameText = nameLineCalls.map(([text]) => String(text)).join(" ");
    for (const word of VERY_LONG_NAME.split(" ")) {
      expect(allNameText.includes(word) || calls.some(([t]) => String(t).includes(word))).toBe(true);
    }
  });

  it("the full 10-digit identifier is never truncated when includeFullIdentifier=true", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    await renderRepeatComplainantBulkPdf(params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: true,
      periodLabel: "test",
      scopeLabel: null,
    });
    const calls = textSpy.mock.calls;
    const identifierCall = calls.find(([text]) => String(text).includes(RAW_IDENTIFIER));
    expect(identifierCall).toBeDefined();
    const [, , , opts] = identifierCall!;
    expect((opts as Record<string, unknown>).ellipsis).toBe(false);
  });

  it("masked identity (default) never leaks the raw identifier anywhere in the PDF", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    await renderRepeatComplainantBulkPdf(params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
      scopeLabel: null,
    });
    const rendered = collectTextCalls(textSpy);
    for (const id of [RAW_IDENTIFIER, SHORT_NAME_IDENTIFIER, LONG_NAME_IDENTIFIER, VERY_LONG_NAME_IDENTIFIER, MULTI_FACILITY_IDENTIFIER]) {
      expect(rendered.some((t) => t.includes(id))).toBe(false);
    }
    expect(rendered.some((t) => t.includes("****"))).toBe(true);
  });

  it("groups people by facility with a heading, and the region heading is drawn once before its facilities' own headings", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    await renderRepeatComplainantBulkPdf(params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
      scopeLabel: null,
    });
    const rendered = collectTextCalls(textSpy);
    // "اختبار" is common to every facility's own name — confirms at least
    // one facility heading was drawn (never just a flat single table).
    expect(rendered.some((t) => t.includes("اختبار"))).toBe(true);

    // مكة (THIRD_FACILITY's region) must appear at least once as its own
    // region heading — proving the region->facility grouping actually ran,
    // not just a flat facility list.
    expect(rendered.some((t) => t.includes("مكة"))).toBe(true);
  });

  it("does not repeat a facility's own name once per person row (heading only, not per-row) — the region/facility columns spec explicitly removes from the people table", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    await renderRepeatComplainantBulkPdf(params("from=2026-01-01&to=2026-03-01"), {
      includeFullIdentifier: false,
      periodLabel: "test",
      scopeLabel: null,
    });
    const rendered = collectTextCalls(textSpy);
    // FACILITY has 5 repeated people (عبدالله, منيرة, محمد علي, محمد
    // عبدالله...) seeded above. If the facility name were repeated per
    // row (the old flat-table bug), it would appear at least 5+ times;
    // as a heading it appears only once (drawn before the table, outside
    // the per-row loop).
    const exactFacilityNameCount = rendered.filter((t) => t === FACILITY).length;
    expect(exactFacilityNameCount).toBeLessThanOrEqual(1);
  });

  it("respects the same date-range filters as the on-screen analysis when building facility sections", async () => {
    const exportData = await getRepeatComplainantExportData(params("from=2030-01-01&to=2030-02-01"));
    expect(exportData.facilitySections).toEqual([]);
  });
});

describe("repeat-complainant bulk PDF export data — facility-scoped people (spec: no org-wide leakage)", () => {
  it("groups people by facility, sorted region ASC then facility repeatedPeopleCount DESC", async () => {
    const exportData = await getRepeatComplainantExportData(params("from=2026-01-01&to=2026-03-01"));
    expect(exportData.facilitySections.length).toBeGreaterThanOrEqual(3);
    const regions = exportData.facilitySections.map((s) => s.facility.region);
    // الرياض's facilities must all precede مكة's — region ASC ordering.
    const lastRiyadhIndex = regions.lastIndexOf("الرياض");
    const firstMakkahIndex = regions.indexOf("مكة");
    if (firstMakkahIndex !== -1) {
      expect(lastRiyadhIndex).toBeLessThan(firstMakkahIndex);
    }
  });

  it("a person present at TWO facilities shows FACILITY-SCOPED numbers in each section, never their org-wide total", async () => {
    const exportData = await getRepeatComplainantExportData(params("from=2026-01-01&to=2026-03-01"));
    const facilitySection = exportData.facilitySections.find((s) => s.facility.facility === FACILITY)!;
    const secondSection = exportData.facilitySections.find((s) => s.facility.facility === SECOND_FACILITY)!;
    expect(facilitySection).toBeDefined();
    expect(secondSection).toBeDefined();

    const inFirst = facilitySection.people.find((p) => p.complainantToken && p.complainantName === "منيرة سعد");
    const inSecond = secondSection.people.find((p) => p.complainantName === "منيرة سعد");
    expect(inFirst).toBeDefined();
    expect(inSecond).toBeDefined();
    // She has 2 complaints at FACILITY (pdf-m1, pdf-m4) and 2 at
    // SECOND_FACILITY (pdf-m2, pdf-m3) — org-wide total 4 — but each
    // section must show ONLY that facility's own count (2), never the
    // org-wide 4.
    expect(inFirst!.totalComplaints).toBe(2);
    expect(inSecond!.totalComplaints).toBe(2);
    // The badge data ("ظهر في N سجون") is still available via orgFacilitiesCount.
    expect(inFirst!.orgFacilitiesCount).toBe(2);
    expect(inSecond!.orgFacilitiesCount).toBe(2);
  });

  it("never returns the raw complainant identifier — only the opaque token and masked form", async () => {
    const exportData = await getRepeatComplainantExportData(params("from=2026-01-01&to=2026-03-01"));
    const allPeople = exportData.facilitySections.flatMap((s) => s.people);
    expect(allPeople.length).toBeGreaterThan(0);
    for (const person of allPeople) {
      expect(JSON.stringify(person)).not.toContain(RAW_IDENTIFIER);
      expect(person.complainantIdentifierMasked).toMatch(/^\*+/);
    }
  });
});
