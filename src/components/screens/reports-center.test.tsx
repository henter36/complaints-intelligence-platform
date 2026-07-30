import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportsCenter } from "./reports-center";

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as Response;
}

const DEFINITIONS = [
  {
    type: "EXECUTIVE_SUMMARY", title: "التقرير التنفيذي الشامل", description: "وصف",
    supportedFilters: ["from", "to"], sections: [], defaultColumns: [], maxRows: 500,
    supportsPdf: true, supportsXlsx: true, requiresPeriod: true,
  },
];

const FILTERS_DATA = { regions: [], departments: [], facilities: [], classifications: [], channels: [] };

function routedFetch(overrides: Record<string, () => Response> = {}) {
  return vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const overrideKey = Object.keys(overrides).find((key) => url.includes(key));
    if (overrideKey) return Promise.resolve(overrides[overrideKey]());
    if (url.includes("/api/reports/definitions")) return Promise.resolve(jsonResponse({ definitions: DEFINITIONS }));
    if (url.includes("/api/filters")) return Promise.resolve(jsonResponse(FILTERS_DATA));
    if (url.includes("/api/reports/templates")) return Promise.resolve(jsonResponse({ templates: [] }));
    if (url.includes("/api/reports/schedules")) return Promise.resolve(jsonResponse({ schedules: [] }));
    if (url.includes("/api/reports/runs")) return Promise.resolve(jsonResponse({ runs: [] }));
    return Promise.resolve(jsonResponse({}));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReportsCenter", () => {
  it("renders available report type cards from the definitions API", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(<ReportsCenter />);

    expect(await screen.findByText("التقرير التنفيذي الشامل")).toBeInTheDocument();
  });

  it("reveals the settings form and export buttons after selecting a report type", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch());
    render(<ReportsCenter />);

    const card = await screen.findByText("التقرير التنفيذي الشامل");
    await user.click(card);

    expect(await screen.findByText(/إعدادات التقرير/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /معاينة/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تصدير PDF/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تصدير XLSX/ })).toBeInTheDocument();
  });

  it("shows a report preview after clicking Preview, using a correctly-shaped POST request", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch({
      "/api/reports/preview": () =>
        jsonResponse({
          report: {
            type: "EXECUTIVE_SUMMARY",
            title: "التقرير التنفيذي الشامل",
            generatedAt: new Date().toISOString(),
            period: { from: "2026-07-01", to: "2026-07-31" },
            filters: { from: "2026-07-01", to: "2026-07-31" },
            sections: [
              {
                id: "kpi_overview", kind: "kpi", title: "المؤشرات الرئيسية",
                cards: [{ key: "total", label: "إجمالي الشكاوى", value: 1240, format: "number" }],
              },
            ],
            warnings: [],
            rowCount: 0,
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReportsCenter />);

    const card = await screen.findByText("التقرير التنفيذي الشامل");
    await user.click(card);
    const previewButton = screen.getByRole("button", { name: /معاينة/ });
    await user.click(previewButton);

    expect(await screen.findByText("إجمالي الشكاوى")).toBeInTheDocument();

    const previewCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/api/reports/preview"));
    expect(previewCall).toBeDefined();
    const [, init] = previewCall!;
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const requestBody = JSON.parse(init?.body as string);
    expect(requestBody).toMatchObject({
      type: "EXECUTIVE_SUMMARY",
      filters: expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
      options: expect.any(Object),
    });
  });

  it("shows an empty state on the Templates tab when none exist", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch());
    render(<ReportsCenter />);

    const templatesTab = await screen.findByRole("tab", { name: /القوالب/ });
    await user.click(templatesTab);

    expect(await screen.findByText("لا توجد قوالب محفوظة بعد")).toBeInTheDocument();
  });

  it("shows an empty state on the Run History tab when none exist", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch());
    render(<ReportsCenter />);

    const historyTab = await screen.findByRole("tab", { name: /سجل التشغيلات/ });
    await user.click(historyTab);

    expect(await screen.findByText("لا توجد تشغيلات بعد")).toBeInTheDocument();
  });
});
