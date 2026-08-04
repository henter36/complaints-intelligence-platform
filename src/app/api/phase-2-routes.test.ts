import { NextRequest } from "next/server";
import { ImportBatchStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireAdminApiSession: vi.fn().mockResolvedValue({ id: "session_test", username: "admin" }),
  mapAuthError: vi.fn().mockReturnValue(null),
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: authMocks.requireAdminApiSession,
  mapAuthError: authMocks.mapAuthError,
}));

beforeEach(() => {
  authMocks.requireAdminApiSession.mockResolvedValue({ id: "session_test", username: "admin" });
  authMocks.mapAuthError.mockReturnValue(null);
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/db");
});

function expectNoComplainantPii(value: unknown): void {
  const forbiddenKeys = new Set([
    "complainantName",
    "complainantIdentifier",
    "complainantPhone",
  ]);

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        expect(forbiddenKeys.has(key)).toBe(false);
        visit(child);
      }
    }
  }

  visit(value);
}

function complaintApiRecord(overrides: Record<string, unknown> = {}) {
  return {
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
    complainantName: "اسم لا يجب أن يظهر",
    complainantIdentifier: "ID-SECRET",
    complainantPhone: "0500000000",
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
    ...overrides,
  };
}

async function callComplaintsApi(query = "") {
  vi.resetModules();
  const findMany = vi.fn().mockResolvedValue([complaintApiRecord()]);
  const count = vi.fn().mockResolvedValue(1);
  vi.doMock("@/lib/db", () => ({
    db: {
      complaint: { findMany, count },
    },
  }));

  const { GET } = await import("./complaints/route");
  const response = await GET(new NextRequest(`http://localhost/api/complaints${query}`));
  const body = await response.json();
  return { response, body, findMany, count };
}

describe("Phase 2 API routes", () => {
  it("does not return a fake success for import approval", async () => {
    const { POST } = await import("./import/approve/route");
    const response = await POST(new NextRequest("http://localhost/api/import/approve", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("IMPORT_BATCH_ID_REQUIRED");
  });

  it("confirms an import batch through the phase 5 confirmation route", async () => {
    vi.resetModules();
    vi.doMock("@/server/auth/auth-guard", () => ({
      requireAdminApiSession: vi.fn().mockResolvedValue({ id: "session_test", username: "admin" }),
      mapAuthError: vi.fn().mockReturnValue(null),
    }));
    const confirmReadyImportBatch = vi.fn().mockResolvedValue({
      batchId: "batch_confirm",
      status: "CONFIRMED",
      confirmedAt: "2026-07-29T00:00:00.000Z",
      created: 1,
      updated: 1,
      unchanged: 0,
      duplicates: 0,
    });
    vi.doMock("@/server/imports/import-confirmation-service", () => ({
      confirmReadyImportBatch,
      toImportConfirmationErrorResponse: vi.fn().mockReturnValue(null),
    }));

    const { POST } = await import("./import/[batchId]/confirm/route");
    const response = await POST(
      new NextRequest("http://localhost/api/import/batch_confirm/confirm", { method: "POST" }),
      { params: Promise.resolve({ batchId: "batch_confirm" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("CONFIRMED");
    expect(confirmReadyImportBatch).toHaveBeenCalledWith("batch_confirm", { actor: "admin" });
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
              complainantName: "اسم لا يجب أن يظهر",
              complainantIdentifier: "ID-SECRET",
              complainantPhone: "0500000000",
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
    expectNoComplainantPii(body);
  });

  it("uses default pagination and sorting when page parameters are absent", async () => {
    const { response, findMany } = await callComplaintsApi();

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ complaintDate: "desc" }, { id: "desc" }],
      skip: 0,
      take: 25,
    }));
  });

  it.each([
    ["?page=1", 0, 25],
    ["?page=2&pageSize=100", 100, 100],
    ["?pageSize=100", 0, 100],
  ])("accepts valid pagination query %s", async (query, expectedSkip, expectedTake) => {
    const { response, findMany } = await callComplaintsApi(query);

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: expectedSkip,
      take: expectedTake,
    }));
  });

  it("returns stable pagination metadata for empty result sets", async () => {
    vi.resetModules();
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    vi.doMock("@/lib/db", () => ({
      db: {
        complaint: { findMany, count },
      },
    }));

    const { GET } = await import("./complaints/route");
    const response = await GET(new NextRequest("http://localhost/api/complaints?page=5&pageSize=20"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: [],
      total: 0,
      page: 5,
      pageSize: 20,
      totalPages: 0,
      hasNextPage: false,
    });
  });

  it.each([
    "?page=0",
    "?page=-1",
    "?page=abc",
    "?page=1.5",
    "?page=12abc",
    `?page=${Number.MAX_SAFE_INTEGER + 1}`,
    "?pageSize=0",
    "?pageSize=-5",
    "?pageSize=101",
    "?sortOrder=ASC",
    "?sortOrder=random",
    "?sortBy=complainantPhone",
  ])("rejects invalid complaints query %s before Prisma", async (query) => {
    const { response, body, findMany, count } = await callComplaintsApi(query);

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_COMPLAINT_QUERY");
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it.each([
    ["?sortOrder=asc", { complaintDate: "asc" }],
    ["?sortOrder=desc", { complaintDate: "desc" }],
    ["?sortBy=dueDate", { dueDate: "desc" }],
    ["?sortBy=status&sortOrder=asc", { status: "asc" }],
  ])("accepts supported complaint sorting %s", async (query, expectedOrderBy) => {
    const { response, findMany } = await callComplaintsApi(query);

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [expectedOrderBy, { id: Object.values(expectedOrderBy)[0] }],
    }));
  });

  it("keeps explicit status when applying isLate=true in the complaints API", async () => {
    vi.resetModules();
    const findMany = vi.fn().mockImplementation(({ where }) => {
      expect(where.status).toBe("IN_PROGRESS");
      expect(where.AND).toEqual([
        {
          dueDate: { lt: expect.any(Date) },
          status: { in: ["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE"] },
        },
      ]);
      return Promise.resolve([
        complaintApiRecord({ id: "in-progress-late", status: "IN_PROGRESS" }),
      ]);
    });
    const count = vi.fn().mockResolvedValue(1);
    vi.doMock("@/lib/db", () => ({
      db: {
        complaint: { findMany, count },
      },
    }));

    const { GET } = await import("./complaints/route");
    const response = await GET(new NextRequest("http://localhost/api/complaints?status=IN_PROGRESS&isLate=true"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].rawStatus).toBe("IN_PROGRESS");
  });

  it("does not replace status=CLOSED with open statuses when isLate=true", async () => {
    vi.resetModules();
    const findMany = vi.fn().mockImplementation(({ where }) => {
      expect(where.status).toBe("CLOSED");
      expect(where.AND).toEqual([
        {
          dueDate: { lt: expect.any(Date) },
          status: { in: ["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE"] },
        },
      ]);
      return Promise.resolve([]);
    });
    const count = vi.fn().mockResolvedValue(0);
    vi.doMock("@/lib/db", () => ({
      db: {
        complaint: { findMany, count },
      },
    }));

    const { GET } = await import("./complaints/route");
    const response = await GET(new NextRequest("http://localhost/api/complaints?status=CLOSED&isLate=true"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([]);
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
    const response = await GET(new NextRequest("http://localhost/api/import/history"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0].status).toBe("approved");
    expect(body[0].uploadedBy.name).toBe("single-admin");
    expect(body[0].rejectionReason).toBeNull();
  });

  it("maps import approval and rejection fields by batch status", async () => {
    vi.resetModules();
    const statuses = Object.values(ImportBatchStatus);
    const notesForStatus = (status: ImportBatchStatus): string => {
      if (status === ImportBatchStatus.ROLLED_BACK) return "";
      if (status === ImportBatchStatus.PARSING) return "تشغيل عادي";
      return `ملاحظة ${status}`;
    };
    vi.doMock("@/lib/db", () => ({
      db: {
        importBatch: {
          findMany: vi.fn().mockResolvedValue(statuses.map((status) => ({
            id: `batch_${status}`,
            fileName: `${status}.csv`,
            originalFileName: `${status}.csv`,
            fileSize: 10,
            periodType: "MONTHLY",
            periodStart: new Date("2026-07-01T00:00:00Z"),
            periodEnd: new Date("2026-07-31T00:00:00Z"),
            status,
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
            notes: notesForStatus(status),
          }))),
        },
      },
    }));

    const { GET } = await import("./import/history/route");
    const response = await GET(new NextRequest("http://localhost/api/import/history"));
    const body = await response.json();

    expect(response.status).toBe(200);
    for (const item of body) {
      const status = item.id.replace("batch_", "");
      if (status === ImportBatchStatus.CONFIRMED) {
        expect(item.approvedAt).not.toBeNull();
        expect(item.approvedById).toBe("single-admin");
      } else {
        expect(item.approvedAt).toBeNull();
        expect(item.approvedById).toBeNull();
      }

      if (status === ImportBatchStatus.FAILED) {
        expect(item.rejectionReason).toBe(`ملاحظة ${status}`);
      } else if (status === ImportBatchStatus.ROLLED_BACK) {
        expect(item.rejectionReason).toBeNull();
      } else {
        expect(item.rejectionReason).toBeNull();
      }
    }
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
    expect(body.error.code).toBe("INVALID_COMPLAINT_QUERY");
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("rejects partial AI insights limit values before querying Prisma", async () => {
    vi.resetModules();
    const findMany = vi.fn();
    vi.doMock("@/lib/db", () => ({
      db: {
        complaint: { findMany },
      },
    }));

    const { GET } = await import("./ai/insights/route");
    const response = await GET(new NextRequest("http://localhost/api/ai/insights?limit=12abc"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("INVALID_AI_INSIGHTS_QUERY");
    expect(findMany).not.toHaveBeenCalled();
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
    expect(body.crossTabs.classificationByRegion).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classification: "أحمد", group: "أحمد", count: 1 }),
        expect.objectContaining({ classification: "أحمد", group: "ياسمين", count: 1 }),
        expect.objectContaining({ classification: "إبراهيم", group: "أحمد", count: 1 }),
      ])
    );
    expect(body.crossTabs.classificationByDepartment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classification: "أحمد", group: "بدر", count: 2 }),
        expect.objectContaining({ classification: "إبراهيم", group: "إبراهيم", count: 1 }),
      ])
    );
    expect(body.anomalies.classifications[0]).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        count: expect.any(Number),
        average: expect.any(Number),
        deviation: expect.any(Number),
        isAnomaly: expect.any(Boolean),
      })
    );
  });

  it("creates a classification only under an active parent category", async () => {
    vi.resetModules();
    const categoryFindFirst = vi.fn().mockResolvedValue({ id: "cat-1" });
    const classificationCreate = vi.fn().mockResolvedValue({
      id: "cls-1",
      categoryId: "cat-1",
      nameAr: "فرعي نشط",
      nameEn: null,
      description: null,
      color: "#64748b",
      keywords: [],
    });
    const classificationFindMany = vi.fn().mockResolvedValue([]);
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = {
      category: { findFirst: categoryFindFirst, create: vi.fn() },
      classification: {
        findMany: classificationFindMany,
        create: classificationCreate,
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      auditLog: { create: auditCreate },
    };
    vi.doMock("@/lib/db", () => ({
      db: {
        $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
        ...tx,
      },
    }));

    const { POST } = await import("./classifications/route");
    const response = await POST(new NextRequest("http://localhost/api/classifications", {
      method: "POST",
      body: JSON.stringify({ name: "فرعي نشط", categoryId: "cat-1" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.parentId).toBe("cat-1");
    expect(body.nodeType).toBe("CLASSIFICATION");
    expect(categoryFindFirst).toHaveBeenCalledWith({
      where: { id: "cat-1", isDeleted: false, isActive: true },
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
    const categoryFindFirst = vi.fn().mockResolvedValue(null);
    const tx = {
      category: { findFirst: categoryFindFirst, create: categoryCreate },
      classification: {
        findMany: vi.fn().mockResolvedValue([]),
        create: classificationCreate,
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    };
    vi.doMock("@/lib/db", () => ({
      db: {
        $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
        ...tx,
      },
    }));

    const { POST } = await import("./classifications/route");
    const response = await POST(new NextRequest("http://localhost/api/classifications", {
      method: "POST",
      body: JSON.stringify({ name: "فرعي مرفوض", categoryId: "deleted-cat" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("CATEGORY_NOT_FOUND");
    expect(classificationCreate).not.toHaveBeenCalled();
    expect(categoryCreate).not.toHaveBeenCalled();
  });

  it("rejects a soft-deleted parent category by requiring an active parent lookup", async () => {
    vi.resetModules();
    const categoryFindFirst = vi.fn().mockResolvedValue(null);
    const classificationCreate = vi.fn();
    const tx = {
      category: { findFirst: categoryFindFirst, create: vi.fn() },
      classification: {
        findMany: vi.fn().mockResolvedValue([]),
        create: classificationCreate,
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    };
    vi.doMock("@/lib/db", () => ({
      db: {
        $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
        ...tx,
      },
    }));

    const { POST } = await import("./classifications/route");
    const response = await POST(new NextRequest("http://localhost/api/classifications", {
      method: "POST",
      body: JSON.stringify({ name: "فرعي محذوف", categoryId: "soft-deleted-cat" }),
    }));

    expect(response.status).toBe(404);
    expect(categoryFindFirst).toHaveBeenCalledWith({
      where: { id: "soft-deleted-cat", isDeleted: false, isActive: true },
      select: { id: true },
    });
    expect(classificationCreate).not.toHaveBeenCalled();
  });

  it("creates a category via POST /api/categories (not classifications without categoryId)", async () => {
    vi.resetModules();
    const categoryCreate = vi.fn().mockResolvedValue({
      id: "cat-root",
      nameAr: "تصنيف رئيسي",
      description: "وصف",
      nameEn: null,
      displayOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const tx = {
      category: {
        findFirst: vi.fn(),
        create: categoryCreate,
      },
      classification: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    vi.doMock("@/lib/db", () => ({
      db: {
        $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
        ...tx,
      },
    }));

    const missingCategoryId = await import("./classifications/route").then(({ POST }) =>
      POST(new NextRequest("http://localhost/api/classifications", {
        method: "POST",
        body: JSON.stringify({ name: "تصنيف رئيسي", description: "وصف" }),
      }))
    );
    expect(missingCategoryId.status).toBe(400);

    const { POST: postCategory } = await import("./categories/route");
    const response = await postCategory(new NextRequest("http://localhost/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "تصنيف رئيسي", description: "وصف" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.parentId).toBeNull();
    expect(body.nodeType).toBe("CATEGORY");
    expect(categoryCreate).toHaveBeenCalledOnce();
  });
});
