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
  findUnique: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  updateMany: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    reportSchedule: {
      findFirst: dbMocks.findFirst,
      findUnique: dbMocks.findUnique,
      update: dbMocks.update,
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

describe("updateReportSchedule — re-enable policy", () => {
  beforeEach(() => {
    dbMocks.findUnique.mockReset();
    dbMocks.update.mockReset();
    dbMocks.auditLogCreate.mockReset().mockResolvedValue({ id: "audit_1" });
  });

  function existingSchedule(overrides: Record<string, unknown> = {}) {
    return {
      id: "sch_1",
      reportTemplateId: "tpl_1",
      frequency: ReportFrequency.DAILY,
      timeOfDay: "07:00",
      dayOfWeek: null,
      dayOfMonth: null,
      timezone: "Asia/Riyadh",
      isEnabled: false,
      nextRunAt: new Date("2026-07-20T04:00:00Z"), // stale (in the past relative to `now` used below)
      lastRunAt: null,
      ...overrides,
    };
  }

  it("recomputes nextRunAt when re-enabling a schedule whose nextRunAt is stale", async () => {
    dbMocks.findUnique.mockResolvedValue(existingSchedule());
    dbMocks.update.mockImplementation(({ data }) => Promise.resolve({ id: "sch_1", ...data }));

    const { updateReportSchedule } = await import("./report-schedule-service");
    const now = new Date("2026-07-30T03:00:00Z");
    await updateReportSchedule("sch_1", { isEnabled: true }, "admin", now);

    const updateArgs = dbMocks.update.mock.calls[0][0];
    expect(updateArgs.data.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    expect(updateArgs.data.nextRunAt.getTime()).not.toBe(existingSchedule().nextRunAt.getTime());
  });

  it("recomputes nextRunAt when re-enabling even if the stored nextRunAt is still in the future", async () => {
    const futureNextRunAt = new Date("2026-08-15T04:00:00Z");
    dbMocks.findUnique.mockResolvedValue(existingSchedule({ nextRunAt: futureNextRunAt }));
    dbMocks.update.mockImplementation(({ data }) => Promise.resolve({ id: "sch_1", ...data }));

    const { updateReportSchedule } = await import("./report-schedule-service");
    const now = new Date("2026-07-30T03:00:00Z");
    await updateReportSchedule("sch_1", { isEnabled: true }, "admin", now);

    const updateArgs = dbMocks.update.mock.calls[0][0];
    // Recomputed relative to `now`, not left as the old future value — proves
    // resumption starts from a slot anchored to the activation time.
    expect(updateArgs.data.nextRunAt.getTime()).not.toBe(futureNextRunAt.getTime());
  });

  it("does not recompute nextRunAt for an unrelated update on an already-enabled schedule", async () => {
    const stableNextRunAt = new Date("2026-08-01T04:00:00Z");
    dbMocks.findUnique.mockResolvedValue(existingSchedule({ isEnabled: true, nextRunAt: stableNextRunAt }));
    dbMocks.update.mockImplementation(({ data }) => Promise.resolve({ id: "sch_1", ...data }));

    const { updateReportSchedule } = await import("./report-schedule-service");
    await updateReportSchedule("sch_1", {}, "admin", new Date("2026-07-30T03:00:00Z"));

    const updateArgs = dbMocks.update.mock.calls[0][0];
    expect(updateArgs.data.nextRunAt.getTime()).toBe(stableNextRunAt.getTime());
  });

  it("still recomputes nextRunAt when only the timing changes, regardless of enabled state", async () => {
    dbMocks.findUnique.mockResolvedValue(existingSchedule({ isEnabled: true, nextRunAt: new Date("2026-08-01T04:00:00Z") }));
    dbMocks.update.mockImplementation(({ data }) => Promise.resolve({ id: "sch_1", ...data }));

    const { updateReportSchedule } = await import("./report-schedule-service");
    const now = new Date("2026-07-30T03:00:00Z");
    await updateReportSchedule("sch_1", { timeOfDay: "09:00" }, "admin", now);

    const updateArgs = dbMocks.update.mock.calls[0][0];
    expect(updateArgs.data.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("does not treat disabling a schedule as a re-enable (no recompute needed)", async () => {
    const stableNextRunAt = new Date("2026-08-01T04:00:00Z");
    dbMocks.findUnique.mockResolvedValue(existingSchedule({ isEnabled: true, nextRunAt: stableNextRunAt }));
    dbMocks.update.mockImplementation(({ data }) => Promise.resolve({ id: "sch_1", ...data }));

    const { updateReportSchedule } = await import("./report-schedule-service");
    await updateReportSchedule("sch_1", { isEnabled: false }, "admin", new Date("2026-07-30T03:00:00Z"));

    const updateArgs = dbMocks.update.mock.calls[0][0];
    expect(updateArgs.data.nextRunAt.getTime()).toBe(stableNextRunAt.getTime());
  });
});
