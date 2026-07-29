import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

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
});
