import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/db");
});

describe("Phase 2 API routes", () => {
  it("does not return a fake success for import approval", async () => {
    const { POST } = await import("./import/approve/route");
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body.error).toBe("NOT_IMPLEMENTED");
  });

  it("returns complaints list from the new schema shape", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      db: {
        complaint: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "cmp_api",
              externalId: "EXT-API-1",
              sourceReference: null,
              complaintDate: new Date("2026-07-01T00:00:00Z"),
              receivedAt: new Date("2026-07-01T00:00:00Z"),
              dueDate: null,
              closedAt: null,
              status: "OPEN",
              subject: "شكوى API",
              description: null,
              complainantName: null,
              complainantIdentifier: null,
              complainantPhone: null,
              region: "الرياض",
              facility: "منشأة",
              department: "إدارة",
              categoryId: null,
              classificationId: null,
              priority: "MEDIUM",
              severity: "MEDIUM",
              channel: "الهاتف",
              resolution: null,
              firstActionAt: null,
              processingStartedAt: null,
              delayReason: null,
              isRepeated: false,
              isValidated: false,
              beneficiarySatisfaction: null,
              aiClassification: null,
              aiConfidence: null,
              aiReasoning: null,
              aiSentiment: null,
              aiSeverityScore: null,
              aiSummary: null,
              aiAnalyzedAt: null,
              isPotentialDuplicate: false,
              classification: null,
              category: null,
            },
          ]),
          count: vi.fn().mockResolvedValue(1),
        },
      },
    }));

    const { GET } = await import("./complaints/route");
    const response = await GET(new NextRequest("http://localhost/api/complaints"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].complaintNumber).toBe("EXT-API-1");
    expect(body.data[0].region).toEqual({ name: "الرياض" });
  });

  it("returns import history without user relations", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      db: {
        importBatch: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "batch_api",
              fileName: "safe.csv",
              originalFileName: "original.csv",
              fileSize: 10,
              periodType: "MONTHLY",
              periodStart: new Date("2026-07-01T00:00:00Z"),
              periodEnd: new Date("2026-07-31T00:00:00Z"),
              status: "CONFIRMED",
              totalRows: 1,
              validRows: 1,
              newRows: 1,
              updatedRows: 0,
              duplicateRows: 0,
              rejectedRows: 0,
              invalidRows: 0,
              createdBy: "single-admin",
              confirmedAt: new Date("2026-07-02T00:00:00Z"),
              createdAt: new Date("2026-07-01T00:00:00Z"),
              updatedAt: new Date("2026-07-01T00:00:00Z"),
              notes: null,
            },
          ]),
        },
      },
    }));

    const { GET } = await import("./import/history/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0].status).toBe("approved");
    expect(body[0].uploadedBy.name).toBe("single-admin");
  });

  it("rejects invalid complaint date filters before querying Prisma", async () => {
    vi.resetModules();
    const findMany = vi.fn();
    const count = vi.fn();
    vi.doMock("@/lib/db", () => ({
      db: {
        complaint: { findMany, count },
      },
    }));

    const { GET } = await import("./complaints/route");
    const response = await GET(new NextRequest("http://localhost/api/complaints?from=not-a-date"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("INVALID_COMPLAINT_QUERY");
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("uses Arabic locale sorting and Phase 2 fields in analytics cross tabs", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      db: {
        complaint: {
          findMany: vi.fn().mockResolvedValue([
            {
              status: "OPEN",
              priority: "MEDIUM",
              complaintDate: new Date("2026-07-01T00:00:00Z"),
              receivedAt: new Date("2026-07-01T00:00:00Z"),
              dueDate: null,
              closedAt: null,
              processingStartedAt: null,
              delayReason: null,
              subject: "أ",
              channel: "هاتف",
              region: "ياسمين",
              department: "بدر",
              classification: { nameAr: "أحمد" },
            },
            {
              status: "CLOSED",
              priority: "LOW",
              complaintDate: new Date("2026-07-02T00:00:00Z"),
              receivedAt: new Date("2026-07-02T00:00:00Z"),
              dueDate: null,
              closedAt: new Date("2026-07-03T00:00:00Z"),
              processingStartedAt: null,
              delayReason: null,
              subject: "ب",
              channel: "هاتف",
              region: "أحمد",
              department: "إبراهيم",
              classification: { nameAr: "إبراهيم" },
            },
            {
              status: "OPEN",
              priority: "HIGH",
              complaintDate: new Date("2026-07-03T00:00:00Z"),
              receivedAt: new Date("2026-07-03T00:00:00Z"),
              dueDate: null,
              closedAt: null,
              processingStartedAt: null,
              delayReason: null,
              subject: "ج",
              channel: "هاتف",
              region: "أحمد",
              department: "بدر",
              classification: { nameAr: "أحمد" },
            },
          ]),
        },
      },
    }));

    const { compareArabicLabels, GET } = await import("./analytics/route");
    const labels = ["ياسمين", "أحمد", "إبراهيم", "بدر"];
    const defaultSorted = [...labels];
    Array.prototype.sort.call(defaultSorted);
    expect(defaultSorted).not.toEqual([...labels].sort(compareArabicLabels));

    const response = await GET(new NextRequest("http://localhost/api/analytics"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.crossTabs.classifications).toEqual(["إبراهيم", "أحمد"]);
    expect(body.crossTabs.regions).toEqual(["أحمد", "ياسمين"]);
    expect(body.crossTabs.departments).toEqual(["إبراهيم", "بدر"]);
    expect(body.crossTabs.classificationByRegion[0].classification).toBe("إبراهيم");
  });

  it("creates a classification only under an active parent category", async () => {
    vi.resetModules();
    const categoryFindFirst = vi.fn().mockResolvedValue({ id: "cat-1" });
    const classificationCreate = vi.fn().mockResolvedValue({
      id: "cls-1",
      categoryId: "cat-1",
      nameAr: "فرعي نشط",
      description: null,
      color: "#64748b",
      keywords: null,
    });
    vi.doMock("@/lib/db", () => ({
      db: {
        category: {
          findFirst: categoryFindFirst,
          create: vi.fn(),
        },
        classification: { create: classificationCreate },
      },
    }));

    const { POST } = await import("./classifications/route");
    const response = await POST(new NextRequest("http://localhost/api/classifications", {
      method: "POST",
      body: JSON.stringify({ name: "فرعي نشط", parentId: " cat-1 " }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.parentId).toBe("cat-1");
    expect(categoryFindFirst).toHaveBeenCalledWith({
      where: { id: "cat-1", isDeleted: false },
      select: { id: true },
    });
    expect(classificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ categoryId: "cat-1" }),
    }));
  });

  it("rejects missing or soft-deleted parent categories without partial writes", async () => {
    vi.resetModules();
    const classificationCreate = vi.fn();
    const categoryCreate = vi.fn();
    vi.doMock("@/lib/db", () => ({
      db: {
        category: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: categoryCreate,
        },
        classification: { create: classificationCreate },
      },
    }));

    const { POST } = await import("./classifications/route");
    const response = await POST(new NextRequest("http://localhost/api/classifications", {
      method: "POST",
      body: JSON.stringify({ name: "فرعي مرفوض", parentId: "deleted-cat" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("CATEGORY_NOT_FOUND");
    expect(classificationCreate).not.toHaveBeenCalled();
    expect(categoryCreate).not.toHaveBeenCalled();
  });

  it("rejects a soft-deleted parent category by requiring an active parent lookup", async () => {
    vi.resetModules();
    const categoryFindFirst = vi.fn().mockResolvedValue(null);
    const classificationCreate = vi.fn();
    vi.doMock("@/lib/db", () => ({
      db: {
        category: {
          findFirst: categoryFindFirst,
          create: vi.fn(),
        },
        classification: { create: classificationCreate },
      },
    }));

    const { POST } = await import("./classifications/route");
    const response = await POST(new NextRequest("http://localhost/api/classifications", {
      method: "POST",
      body: JSON.stringify({ name: "فرعي محذوف", parentId: "soft-deleted-cat" }),
    }));

    expect(response.status).toBe(404);
    expect(categoryFindFirst).toHaveBeenCalledWith({
      where: { id: "soft-deleted-cat", isDeleted: false },
      select: { id: true },
    });
    expect(classificationCreate).not.toHaveBeenCalled();
  });

  it("still creates a category when parentId is absent", async () => {
    vi.resetModules();
    const categoryCreate = vi.fn().mockResolvedValue({
      id: "cat-root",
      nameAr: "تصنيف رئيسي",
      description: "وصف",
      nameEn: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.doMock("@/lib/db", () => ({
      db: {
        category: {
          findFirst: vi.fn(),
          create: categoryCreate,
        },
        classification: { create: vi.fn() },
      },
    }));

    const { POST } = await import("./classifications/route");
    const response = await POST(new NextRequest("http://localhost/api/classifications", {
      method: "POST",
      body: JSON.stringify({ name: "تصنيف رئيسي", description: "وصف" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.parentId).toBeNull();
    expect(categoryCreate).toHaveBeenCalledOnce();
  });
});
