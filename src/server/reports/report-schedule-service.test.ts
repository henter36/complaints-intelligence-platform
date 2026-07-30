import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ReportFrequency } from "@prisma/client";
import { computeNextRunAt } from "./report-schedule-service";

describe("computeNextRunAt", () => {
  it("DAILY: schedules later today when the time has not passed yet (Riyadh)", () => {
    const next = computeNextRunAt(
      { frequency: ReportFrequency.DAILY, timeOfDay: "07:00", timezone: "Asia/Riyadh" },
      new Date("2026-07-30T03:00:00Z")
    );
    expect(next.toISOString()).toBe("2026-07-30T04:00:00.000Z");
  });

  it("DAILY: rolls to tomorrow when today's time has already passed", () => {
    const next = computeNextRunAt(
      { frequency: ReportFrequency.DAILY, timeOfDay: "07:00", timezone: "Asia/Riyadh" },
      new Date("2026-07-30T05:00:00Z")
    );
    expect(next.toISOString()).toBe("2026-07-31T04:00:00.000Z");
  });

  it("WEEKLY: finds the next configured weekday", () => {
    // 2026-07-30 is a Thursday; next Monday (dayOfWeek=1) is 2026-08-03.
    const next = computeNextRunAt(
      { frequency: ReportFrequency.WEEKLY, timeOfDay: "09:00", dayOfWeek: 1, timezone: "Asia/Riyadh" },
      new Date("2026-07-30T05:00:00Z")
    );
    expect(next.toISOString()).toBe("2026-08-03T06:00:00.000Z");
  });

  it("WEEKLY: rolls to next week when today matches the weekday but the time already passed", () => {
    // 2026-07-30 is Thursday (weekday=4); requesting dayOfWeek=4 with a time already past.
    const next = computeNextRunAt(
      { frequency: ReportFrequency.WEEKLY, timeOfDay: "01:00", dayOfWeek: 4, timezone: "Asia/Riyadh" },
      new Date("2026-07-30T05:00:00Z")
    );
    expect(next.toISOString()).toBe("2026-08-05T22:00:00.000Z");
  });

  it("MONTHLY: uses the last day of the month when dayOfMonth does not exist (Feb 31 -> Feb 28)", () => {
    const next = computeNextRunAt(
      { frequency: ReportFrequency.MONTHLY, timeOfDay: "06:00", dayOfMonth: 31, timezone: "Asia/Riyadh" },
      new Date("2026-02-10T00:00:00Z")
    );
    expect(next.toISOString()).toBe("2026-02-28T03:00:00.000Z");
  });

  it("MONTHLY: rolls to next month once the configured day has passed", () => {
    const next = computeNextRunAt(
      { frequency: ReportFrequency.MONTHLY, timeOfDay: "06:00", dayOfMonth: 15, timezone: "Asia/Riyadh" },
      new Date("2026-07-20T00:00:00Z")
    );
    expect(next.toISOString()).toBe("2026-08-15T03:00:00.000Z");
  });

  it("MONTHLY: does not skip a month for a 30-day target when run from Feb (28-day month uses last day)", () => {
    const next = computeNextRunAt(
      { frequency: ReportFrequency.MONTHLY, timeOfDay: "06:00", dayOfMonth: 30, timezone: "Asia/Riyadh" },
      new Date("2026-02-01T00:00:00Z")
    );
    expect(next.toISOString()).toBe("2026-02-28T03:00:00.000Z");
  });
});

const dbMocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  count: vi.fn(),
  updateMany: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    reportSchedule: {
      findFirst: dbMocks.findFirst,
      updateMany: dbMocks.updateMany,
    },
    reportRun: {
      count: dbMocks.count,
    },
    auditLog: {
      create: dbMocks.auditLogCreate,
    },
  },
}));

vi.mock("./report-template-service", () => ({
  getReportTemplateOrThrow: vi.fn(),
  runReportTemplate: vi.fn(),
}));

describe("runDueSchedule", () => {
  beforeEach(() => {
    dbMocks.findFirst.mockReset();
    dbMocks.count.mockReset();
    dbMocks.updateMany.mockReset();
    dbMocks.auditLogCreate.mockReset().mockResolvedValue({ id: "audit_1" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns no_due_schedule when nothing is due", async () => {
    dbMocks.findFirst.mockResolvedValue(null);
    const { runDueSchedule } = await import("./report-schedule-service");
    const result = await runDueSchedule(new Date());
    expect(result).toEqual({ ran: false, reason: "no_due_schedule" });
  });

  it("skips when a run for the same template is already RUNNING (prevents duplicate execution)", async () => {
    dbMocks.findFirst.mockResolvedValue({
      id: "sch_1", reportTemplateId: "tpl_1", nextRunAt: new Date("2026-07-30T04:00:00Z"),
      frequency: "DAILY", timeOfDay: "07:00", dayOfWeek: null, dayOfMonth: null, timezone: "Asia/Riyadh",
    });
    dbMocks.count.mockResolvedValue(1);
    const { runDueSchedule } = await import("./report-schedule-service");
    const result = await runDueSchedule(new Date("2026-07-30T05:00:00Z"));
    expect(result).toEqual({ ran: false, reason: "already_running", scheduleId: "sch_1" });
    expect(dbMocks.updateMany).not.toHaveBeenCalled();
  });

  it("does not execute twice when nextRunAt was already claimed by another process (contended)", async () => {
    dbMocks.findFirst.mockResolvedValue({
      id: "sch_1", reportTemplateId: "tpl_1", nextRunAt: new Date("2026-07-30T04:00:00Z"),
      frequency: "DAILY", timeOfDay: "07:00", dayOfWeek: null, dayOfMonth: null, timezone: "Asia/Riyadh",
    });
    dbMocks.count.mockResolvedValue(0);
    dbMocks.updateMany.mockResolvedValue({ count: 0 });
    const { runDueSchedule } = await import("./report-schedule-service");
    const result = await runDueSchedule(new Date("2026-07-30T05:00:00Z"));
    expect(result).toEqual({ ran: false, reason: "contended", scheduleId: "sch_1" });
  });
});
