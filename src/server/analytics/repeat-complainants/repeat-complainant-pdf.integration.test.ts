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

async function seed(prisma: PrismaClient) {
  const category = await prisma.category.create({ data: { nameAr: "فئة PDF", nameEn: "PDF", isActive: true } });
  const cls = await prisma.classification.create({
    data: { categoryId: category.id, nameAr: "التغذية", nameEn: "Food", isActive: true },
  });
  const key = normalizeFacilityName(FACILITY);
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
});
