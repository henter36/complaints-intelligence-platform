import { describe, expect, it } from "vitest";
import { FacilityStatus } from "@prisma/client";

import {
  createFacilityOperationalRegistry,
  isFacilityCurrentlyEligible,
  isFacilityEligibleAt,
  isFacilityEligibleForPeriod,
  isFacilityEventEligible,
} from "./facility-operational-scope-service";

const closedAt = new Date("2026-08-01T00:00:00.000Z");
const registry = createFacilityOperationalRegistry([
  {
    id: "active",
    name: "سجن نشط",
    normalizedName: "سجن نشط",
    region: "منطقة الرياض",
    status: FacilityStatus.ACTIVE,
    closedAt: null,
  },
  {
    id: "closed",
    name: "سجن مقفل",
    normalizedName: "سجن مقفل",
    region: "منطقة الرياض",
    status: FacilityStatus.CLOSED,
    closedAt,
  },
]);

describe("facility operational eligibility", () => {
  it("includes ACTIVE and unregistered legacy names in current scope", () => {
    expect(isFacilityCurrentlyEligible(registry, "سجن نشط")).toBe(true);
    expect(isFacilityCurrentlyEligible(registry, "اسم تاريخي غير مسجل")).toBe(true);
  });

  it("excludes CLOSED from current instantaneous scope", () => {
    expect(isFacilityCurrentlyEligible(registry, "سجن مقفل")).toBe(false);
  });

  it("keeps historical instants before closure and excludes closure or later", () => {
    expect(isFacilityEligibleAt(registry, "سجن مقفل", new Date("2026-07-31T23:59:59.999Z"))).toBe(true);
    expect(isFacilityEligibleAt(registry, "سجن مقفل", closedAt)).toBe(false);
    expect(isFacilityEligibleAt(registry, "سجن مقفل", new Date("2026-09-01T00:00:00.000Z"))).toBe(false);
  });

  it("applies the period-start rule before/during/after closure", () => {
    expect(isFacilityEligibleForPeriod(registry, "سجن مقفل", {
      from: new Date("2026-06-01T00:00:00.000Z"),
      toExclusive: new Date("2026-07-01T00:00:00.000Z"),
    })).toBe(true);
    expect(isFacilityEligibleForPeriod(registry, "سجن مقفل", {
      from: new Date("2026-07-01T00:00:00.000Z"),
      toExclusive: new Date("2026-09-01T00:00:00.000Z"),
    })).toBe(true);
    expect(isFacilityEligibleForPeriod(registry, "سجن مقفل", {
      from: new Date("2026-09-01T00:00:00.000Z"),
      toExclusive: new Date("2026-10-01T00:00:00.000Z"),
    })).toBe(false);
  });

  it("allows events before an in-period closure and rejects events at/after it", () => {
    expect(isFacilityEventEligible(registry, "سجن مقفل", new Date("2026-07-20T00:00:00.000Z"))).toBe(true);
    expect(isFacilityEventEligible(registry, "سجن مقفل", new Date("2026-08-02T00:00:00.000Z"))).toBe(false);
  });
});
