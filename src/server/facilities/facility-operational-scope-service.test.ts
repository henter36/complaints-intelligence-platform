import { describe, expect, it, vi } from "vitest";
import { FacilityStatus } from "@prisma/client";

import {
  createFacilityOperationalRegistry,
  buildCurrentOperationalFacilityWhere,
  buildHistoricalFacilityClosureEventWhere,
  buildHistoricalOperationalFacilityWhere,
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

const nullClosureRegistry = createFacilityOperationalRegistry([
  {
    id: "closed-unknown",
    name: "سجن إغلاق مجهول",
    normalizedName: "سجن اغلاق مجهول",
    region: null,
    status: FacilityStatus.CLOSED,
    closedAt: null,
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

  it("excludes CLOSED/null currently but retains it historically", () => {
    expect(isFacilityCurrentlyEligible(nullClosureRegistry, "سجن إغلاق مجهول")).toBe(false);
    expect(isFacilityEligibleAt(
      nullClosureRegistry,
      "سجن إغلاق مجهول",
      new Date("2020-01-01T00:00:00.000Z")
    )).toBe(true);
  });

  it("does not add CLOSED/null registry keys to historical database exclusions", async () => {
    const currentClient = {
      facility: {
        findMany: vi.fn().mockResolvedValue([
          { normalizedName: "سجن اغلاق مجهول", closedAt: null },
        ]),
      },
    } as never;
    expect(await buildCurrentOperationalFacilityWhere(currentClient)).toEqual({
      OR: [
        { facilityNormalizedName: null },
        { facilityNormalizedName: { notIn: ["سجن اغلاق مجهول"] } },
      ],
    });

    const historicalFindMany = vi.fn().mockResolvedValue([]);
    const historicalClient = {
      facility: { findMany: historicalFindMany },
    } as never;
    expect(await buildHistoricalOperationalFacilityWhere(historicalClient)).toEqual({});
    expect(historicalFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: FacilityStatus.CLOSED, closedAt: { not: null } },
    }));
  });

  it("builds every operational scope with one registry query and no Complaint scan", async () => {
    for (const complaintRowCount of [100, 100_000]) {
      const findMany = vi.fn()
        .mockResolvedValueOnce([
          { normalizedName: "سجن مقفل", closedAt: null },
        ])
        .mockResolvedValueOnce([
          { normalizedName: "سجن مقفل", closedAt },
        ])
        .mockResolvedValueOnce([
          { normalizedName: "سجن مقفل", closedAt },
        ]);
      const client = {
        facility: { findMany },
        // Deliberately no complaint delegate: row count cannot affect query shape.
        complaintRowCount,
      } as never;

      expect(await buildCurrentOperationalFacilityWhere(client)).toEqual({
        OR: [
          { facilityNormalizedName: null },
          { facilityNormalizedName: { notIn: ["سجن مقفل"] } },
        ],
      });
      const historical = await buildHistoricalOperationalFacilityWhere(client);
      const closureEvents = await buildHistoricalFacilityClosureEventWhere(client);

      expect(JSON.stringify(historical)).toContain("facilityNormalizedName");
      expect(JSON.stringify(closureEvents)).toContain("facilityNormalizedName");
      expect(findMany).toHaveBeenCalledTimes(3);
      expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
        where: { status: FacilityStatus.CLOSED, closedAt: { not: null } },
      }));
    }
  });
});
