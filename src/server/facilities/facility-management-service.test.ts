import { describe, expect, it } from "vitest";
import { FacilityStatus } from "@prisma/client";

import {
  FacilityManagementError,
  parseFacilityStatus,
  parseFacilityUpdatePayload,
} from "./facility-management-service";

describe("facility management validation", () => {
  it("rejects invalid statuses with a structured code", () => {
    expect(() => parseFacilityStatus("ARCHIVED")).toThrowError(
      expect.objectContaining({ code: "INVALID_FACILITY_STATUS" }) as FacilityManagementError
    );
  });

  it("requires a valid closedAt for CLOSED", () => {
    expect(() => parseFacilityUpdatePayload({ status: "CLOSED", closedAt: null })).toThrowError(
      expect.objectContaining({ code: "MISSING_FACILITY_CLOSED_AT" }) as FacilityManagementError
    );
    expect(() => parseFacilityUpdatePayload({ status: "CLOSED", closedAt: "not-a-date" })).toThrowError(
      expect.objectContaining({ code: "INVALID_FACILITY_CLOSED_AT" }) as FacilityManagementError
    );
  });

  it("parses CLOSED and always clears closedAt when returning to ACTIVE", () => {
    const closed = parseFacilityUpdatePayload({ status: "CLOSED", closedAt: "2026-08-01" });
    expect(closed.status).toBe(FacilityStatus.CLOSED);
    expect(closed.closedAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");

    expect(parseFacilityUpdatePayload({
      status: "ACTIVE",
      closedAt: "2020-01-01",
    })).toEqual({ status: FacilityStatus.ACTIVE, closedAt: null });
  });
});
