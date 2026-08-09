// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { displayDate, filterManagedFacilities, Settings, type ManagedFacility } from "./settings";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

const rows: ManagedFacility[] = [
  {
    id: "active-1",
    name: "سجن الرياض التجريبي",
    region: "منطقة الرياض",
    status: "ACTIVE",
    closedAt: null,
  },
  {
    id: "closed-1",
    name: "سجن مكة المغلق",
    region: "منطقة مكة المكرمة",
    status: "CLOSED",
    closedAt: "2026-07-01T00:00:00.000Z",
  },
];

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("Settings facility management", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    toastSpy.mockReset();
  });

  it("renders closure dates in the Gregorian calendar at the stored UTC day", () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu";
      const behindUtc = displayDate("2026-07-01T00:00:00.000Z");
      process.env.TZ = "Pacific/Kiritimati";
      const aheadOfUtc = displayDate("2026-07-01T00:00:00.000Z");

      expect(behindUtc).toBe(aheadOfUtc);
      expect(behindUtc).toMatch(/2026|٢٠٢٦/);
      expect(behindUtc).toMatch(/01|١|٠١/);
      expect(behindUtc).not.toMatch(/1447|1448|١٤٤٧|١٤٤٨/);
      expect(displayDate(null)).toBe("—");
    } finally {
      process.env.TZ = originalTimezone;
    }
  });

  it("filters by search, status, and region without mixing facilities", () => {
    expect(filterManagedFacilities(rows, {
      search: "الرياض",
      status: "ACTIVE",
      region: "منطقة الرياض",
    }).map((row) => row.id)).toEqual(["active-1"]);
    expect(filterManagedFacilities(rows, {
      search: "",
      status: "CLOSED",
      region: "all",
    }).map((row) => row.id)).toEqual(["closed-1"]);
  });

  it("loads rows, searches by name, confirms closure with a date, and updates locally", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ facilities: rows }))
      .mockResolvedValueOnce(response({
        facility: {
          ...rows[0],
          status: "CLOSED",
          closedAt: "2026-08-09T00:00:00.000Z",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<Settings />);

    expect(await screen.findByText("سجن الرياض التجريبي")).toBeInTheDocument();
    await user.type(screen.getByLabelText("البحث بالاسم"), "مكة");
    expect(screen.queryByText("سجن الرياض التجريبي")).not.toBeInTheDocument();
    expect(screen.getByText("سجن مكة المغلق")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("البحث بالاسم"));

    const activeRow = screen.getByText("سجن الرياض التجريبي").closest("tr");
    expect(activeRow).not.toBeNull();
    await user.click(within(activeRow!).getByRole("button", { name: "تغيير الحالة" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("سيتم استبعاد هذا السجن من التحليلات");
    fireEvent.change(screen.getByLabelText("تاريخ الإغلاق"), { target: { value: "2026-08-09" } });
    await user.click(screen.getByRole("button", { name: "تأكيد تغيير الحالة" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH" });
    expect(await screen.findByText("سجن الرياض التجريبي")).toBeInTheDocument();
    expect(within(screen.getByText("سجن الرياض التجريبي").closest("tr")!).getByText("مقفل")).toBeInTheDocument();
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "تم حفظ الحالة" }));
  });

  it("keeps the original state and exposes the API error when saving fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ facilities: [rows[0]] }))
      .mockResolvedValueOnce(response({
        error: { code: "FACILITY_UPDATE_FAILED", message: "تعذر الحفظ التجريبي" },
      }, false));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<Settings />);

    const name = await screen.findByText("سجن الرياض التجريبي");
    await user.click(within(name.closest("tr")!).getByRole("button", { name: "تغيير الحالة" }));
    await user.click(screen.getByRole("button", { name: "تأكيد تغيير الحالة" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("تعذر الحفظ التجريبي");
    const tableName = within(document.querySelector("table")!).getByText("سجن الرياض التجريبي");
    expect(within(tableName.closest("tr")!).getByText("نشط")).toBeInTheDocument();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("shows loading/error/empty states and retries without a full reload", async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(response({ facilities: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<Settings />);
    expect(screen.getByRole("status", { name: "جارٍ تحميل السجون" })).toBeInTheDocument();
    resolveFirst(response({ error: { message: "تعذر الاتصال" } }, false));
    expect(await screen.findByText("تعذر الاتصال")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /إعادة المحاولة/ }));
    expect(await screen.findByText("لا توجد سجون مطابقة للفلاتر الحالية.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
