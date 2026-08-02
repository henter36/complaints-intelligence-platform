import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  mapAuthError: vi.fn(),
  listValues: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: mocks.requireSession,
  mapAuthError: mocks.mapAuthError,
}));

vi.mock("@/server/classifications/imported-detail-values-service", () => ({
  listImportedDetailValues: mocks.listValues,
}));

vi.mock("@/server/logger", () => ({
  logger: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn() },
}));

import { GET, parseImportedDetailLinkStatus } from "./route";

describe("imported detail values route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ username: "admin" });
    mocks.mapAuthError.mockReturnValue(null);
    mocks.listValues.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 50,
      total: 0,
      availableTotal: 0,
    });
  });

  it.each([
    [null, "ALL"],
    ["all", "ALL"],
    ["unlinked", "UNLINKED"],
    ["linked-current", "CURRENT"],
    ["linked-other", "OTHER"],
    ["unsupported", "ALL"],
  ] as const)("maps link status %s to %s", (input, expected) => {
    expect(parseImportedDetailLinkStatus(input)).toBe(expected);
  });

  it("requires a session and returns pagination metadata without PII", async () => {
    mocks.listValues.mockResolvedValue({
      items: [{
        normalizedValue: "طلب نقل",
        displayValue: "طلب نقل",
        occurrences: 1,
        linkedKeywordsCount: 0,
        alreadyLinkedToCurrentClassification: false,
        linkedToOtherClassification: false,
      }],
      page: 2,
      pageSize: 10,
      total: 11,
      availableTotal: 20,
    });
    const request = new NextRequest(
      "http://localhost/api/classifications/imported-detail-values?page=2&pageSize=10&classificationId=cls_1&linkStatus=all"
    );
    const response = await GET(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requireSession).toHaveBeenCalledWith(request);
    expect(mocks.listValues).toHaveBeenCalledWith({
      search: undefined,
      classificationId: "cls_1",
      linkStatus: "ALL",
      page: 2,
      pageSize: 10,
    });
    expect(payload).toMatchObject({ page: 2, pageSize: 10, total: 11, availableTotal: 20 });
    expect(JSON.stringify(payload)).not.toContain("complaintId");
    expect(JSON.stringify(payload)).not.toContain("description");
  });

  it("returns a structured 500 instead of hiding query failures as empty data", async () => {
    mocks.listValues.mockRejectedValue(new Error("database detail"));
    const response = await GET(new NextRequest("http://localhost/api/classifications/imported-detail-values"));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      error: {
        code: "IMPORTED_DETAIL_VALUES_FAILED",
        message: "تعذر تحميل قيم تفصيل المستوردة",
      },
    });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Imported detail values lookup failed",
      { errorType: "Error" }
    );
  });
});
