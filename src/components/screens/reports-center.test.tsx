import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReportsCenter,
  buildSupportedFiltersPayload,
  requiresReportPeriod,
  resetUnsupportedFilters,
  supportsFilter,
  validatePeriod,
} from "./reports-center";

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as Response;
}

function errorResponse(status: number, message: string, code?: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: { message, code } }),
  } as Response;
}

const EXECUTIVE_SUMMARY_DEFINITION = {
  type: "EXECUTIVE_SUMMARY", title: "التقرير التنفيذي الشامل", description: "وصف",
  supportedFilters: ["from", "to"], sections: [], defaultColumns: [], maxRows: 500,
  supportsPdf: true, supportsXlsx: true, requiresPeriod: true,
};

const DEPARTMENT_PERFORMANCE_DEFINITION = {
  type: "DEPARTMENT_PERFORMANCE", title: "تقرير أداء الإدارات", description: "وصف",
  // Deliberately supports "region" but not "department", to test that an
  // unsupported filter never renders and never reaches the request payload.
  supportedFilters: ["from", "to", "region"], sections: [], defaultColumns: [], maxRows: 1000,
  supportsPdf: true, supportsXlsx: true, requiresPeriod: true,
};

const CLASSIFICATION_DEFINITION = {
  type: "CLASSIFICATION_ANALYSIS", title: "تقرير التصنيفات", description: "وصف",
  supportedFilters: ["region"], sections: [], defaultColumns: [], maxRows: 1000,
  supportsPdf: true, supportsXlsx: true, requiresPeriod: false,
};

const DEFINITIONS = [EXECUTIVE_SUMMARY_DEFINITION, DEPARTMENT_PERFORMANCE_DEFINITION, CLASSIFICATION_DEFINITION];

const FILTERS_DATA = {
  regions: [{ id: "riyadh", name: "الرياض" }],
  departments: [{ id: "support", name: "الدعم الفني" }],
  facilities: [],
  classifications: [],
  channels: [],
};

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

  it("shows all report modes for executive reports with digital selected by default", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch());
    render(<ReportsCenter />);
    await user.click(await screen.findByText("التقرير التنفيذي الشامل"));

    expect(screen.getByText("نمط التقرير")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /التقرير التنفيذي المختصر — عرض رقمي/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /التقرير التنفيذي المختصر — طباعة/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /التقرير التحليلي الكامل/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /التقرير القياسي/ })).toBeInTheDocument();
    expect(screen.getByText("مقترح")).toBeInTheDocument();
    expect(screen.getByText(/ثلاث صفحات أفقية احترافية/)).toBeInTheDocument();
  });

  it("hides report modes and resets the hidden value after changing report type", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch({
      "/api/reports/preview": () => jsonResponse({ report: {
        type: "DEPARTMENT_PERFORMANCE", title: "الإدارات", generatedAt: new Date().toISOString(),
        period: { from: "2026-07-01", to: "2026-07-31" }, filters: {}, sections: [], warnings: [], rowCount: 0,
      } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReportsCenter />);
    await user.click(await screen.findByText("التقرير التنفيذي الشامل"));
    await user.click(screen.getByRole("radio", { name: /التقرير التنفيذي المختصر — طباعة/ }));
    await user.click(screen.getByText("تقرير أداء الإدارات"));
    expect(screen.queryByText("نمط التقرير")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /معاينة/ }));
    const previewCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/api/reports/preview"));
    const body = JSON.parse(previewCall?.[1]?.body as string);
    expect(body.options.reportMode).toBe("STANDARD");
  });

  it("sends the selected mode in preview and presents a three-page 16:9 preview", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch({
      "/api/reports/preview": () => jsonResponse({ report: {
        type: "EXECUTIVE_SUMMARY", reportMode: "DIGITAL_EXECUTIVE_BRIEF", title: "المختصر الرقمي",
        generatedAt: new Date().toISOString(), period: { from: "2026-07-01", to: "2026-07-31" },
        filters: {}, sections: [], warnings: [], rowCount: 0,
      } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReportsCenter />);
    await user.click(await screen.findByText("التقرير التنفيذي الشامل"));
    await user.click(screen.getByRole("button", { name: /معاينة/ }));
    expect(await screen.findByText("معاينة رقمية بنسبة 16:9 — ثلاث صفحات")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/صفحة [123] من 3/)).toHaveLength(3);
    const previewCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/api/reports/preview"));
    expect(JSON.parse(previewCall?.[1]?.body as string).options.reportMode).toBe("DIGITAL_EXECUTIVE_BRIEF");
  });

  it("preserves the selected FULL_ANALYTICAL mode when saving a template", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch({
      "/api/reports/templates": () => jsonResponse({ template: { id: "tpl-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReportsCenter />);
    await user.click(await screen.findByText("التقرير التنفيذي الشامل"));
    await user.click(screen.getByRole("radio", { name: /التقرير التحليلي الكامل/ }));
    await user.click(screen.getByRole("button", { name: /حفظ كقالب/ }));
    await user.type(screen.getByPlaceholderText("مثال: التقرير التنفيذي الشهري"), "قالب تحليلي");
    await user.click(screen.getByRole("button", { name: /^حفظ$/ }));
    const createCall = fetchMock.mock.calls.find(([input, init]) =>
      String(input).includes("/api/reports/templates") && init?.method === "POST"
    );
    expect(JSON.parse(createCall?.[1]?.body as string).options.reportMode).toBe("FULL_ANALYTICAL");
  });

  it("sends PRINT_EXECUTIVE_BRIEF when running an export", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch({
      "/api/reports/run": () => jsonResponse({ run: { artifacts: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReportsCenter />);
    await user.click(await screen.findByText("التقرير التنفيذي الشامل"));
    await user.click(screen.getByRole("radio", { name: /التقرير التنفيذي المختصر — طباعة/ }));
    await user.click(screen.getByRole("button", { name: /تصدير PDF/ }));
    const runCall = await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input).includes("/api/reports/run"));
      expect(call).toBeDefined();
      return call;
    });
    expect(JSON.parse(runCall?.[1]?.body as string).options.reportMode).toBe("PRINT_EXECUTIVE_BRIEF");
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

  it("reads and labels reportMode from a saved template", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch({
      "/api/reports/templates": () => jsonResponse({ templates: [{
        id: "tpl-digital", name: "قالب الإدارة", description: null,
        reportType: "EXECUTIVE_SUMMARY", isActive: true, lastRunAt: null,
        createdAt: new Date().toISOString(), schedules: [],
        options: { reportMode: "DIGITAL_EXECUTIVE_BRIEF" },
      }] }),
    }));
    render(<ReportsCenter />);
    await user.click(await screen.findByRole("tab", { name: /القوالب/ }));
    expect(await screen.findByText("التقرير التنفيذي المختصر — عرض رقمي")).toBeInTheDocument();
  });

  it("shows an empty state on the Run History tab when none exist", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch());
    render(<ReportsCenter />);

    const historyTab = await screen.findByRole("tab", { name: /سجل التشغيلات/ });
    await user.click(historyTab);

    expect(await screen.findByText("لا توجد تشغيلات بعد")).toBeInTheDocument();
  });

  it("shows an explicit error state (not an empty list) when the templates request fails with 401", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({ "/api/reports/templates": () => errorResponse(401, "يلزم تسجيل الدخول") })
    );
    render(<ReportsCenter />);

    const templatesTab = await screen.findByRole("tab", { name: /القوالب/ });
    await user.click(templatesTab);

    expect(await screen.findByText("يلزم تسجيل الدخول")).toBeInTheDocument();
    expect(screen.queryByText("لا توجد قوالب محفوظة بعد")).not.toBeInTheDocument();
  });

  it("shows an explicit error state when the schedules request fails with 500", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({ "/api/reports/schedules": () => errorResponse(500, "خطأ داخلي في الخادم") })
    );
    render(<ReportsCenter />);

    const schedulesTab = await screen.findByRole("tab", { name: /الجداول/ });
    await user.click(schedulesTab);

    expect(await screen.findByText("خطأ داخلي في الخادم")).toBeInTheDocument();
  });

  it("retrying after a failed load successfully repopulates the list", async () => {
    const user = userEvent.setup();
    let templatesCallCount = 0;
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "/api/reports/templates": () => {
          templatesCallCount += 1;
          return templatesCallCount === 1 ? errorResponse(500, "خطأ داخلي") : jsonResponse({ templates: [] });
        },
      })
    );
    render(<ReportsCenter />);

    const templatesTab = await screen.findByRole("tab", { name: /القوالب/ });
    await user.click(templatesTab);
    expect(await screen.findByText("خطأ داخلي")).toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: /إعادة المحاولة/ });
    await user.click(retryButton);

    expect(await screen.findByText("لا توجد قوالب محفوظة بعد")).toBeInTheDocument();
    expect(templatesCallCount).toBe(2);
  });

  it("shows an error state (not empty definitions) when the initial load fails", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ "/api/reports/definitions": () => errorResponse(500, "تعذر تحميل الأنواع") })
    );
    render(<ReportsCenter />);

    expect(await screen.findByText("تعذر تحميل الأنواع")).toBeInTheDocument();
  });

  it("aborts in-flight initial requests on unmount (never surfaced as an error)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/reports/definitions")) {
        capturedSignal = init?.signal ?? undefined;
        return new Promise(() => {
          // never resolves — simulates a slow request outlived by the component
        });
      }
      if (url.includes("/api/filters")) return Promise.resolve(jsonResponse(FILTERS_DATA));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<ReportsCenter />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("only shows filters supported by the selected report type (region shown, department hidden)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch());
    render(<ReportsCenter />);

    const card = await screen.findByText("تقرير أداء الإدارات");
    await user.click(card);

    expect(await screen.findByText(/إعدادات التقرير/)).toBeInTheDocument();
    expect(screen.getByText("المنطقة")).toBeInTheDocument();
    expect(screen.queryByText("الإدارة")).not.toBeInTheDocument();
  });

  it("does not render date filters for a report type that does not require a period", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch());
    const { container } = render(<ReportsCenter />);
    const card = await screen.findByText("تقرير التصنيفات");
    await user.click(card);

    expect(await screen.findByText(/إعدادات التقرير/)).toBeInTheDocument();
    expect(container.querySelectorAll('input[type="date"]')).toHaveLength(0);
  });

  it("blocks preview when a required period is missing, without calling the preview API", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ReportsCenter />);

    const card = await screen.findByText("التقرير التنفيذي الشامل");
    await user.click(card);

    const fromInput = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(fromInput).toBeTruthy();
    await user.clear(fromInput);

    const previewButton = screen.getByRole("button", { name: /معاينة/ });
    await user.click(previewButton);
    await act(async () => {
      await Promise.resolve();
    });

    const previewCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/reports/preview"));
    expect(previewCalls).toHaveLength(0);
  });
});

describe("supportsFilter / requiresReportPeriod", () => {
  it("reports false for a null definition", () => {
    expect(supportsFilter(null, "region")).toBe(false);
    expect(requiresReportPeriod(null)).toBe(false);
  });

  it("reflects the definition's supportedFilters and requiresPeriod", () => {
    expect(supportsFilter(DEPARTMENT_PERFORMANCE_DEFINITION as any, "region")).toBe(true);
    expect(supportsFilter(DEPARTMENT_PERFORMANCE_DEFINITION as any, "department")).toBe(false);
    expect(requiresReportPeriod(CLASSIFICATION_DEFINITION as any)).toBe(false);
    expect(requiresReportPeriod(EXECUTIVE_SUMMARY_DEFINITION as any)).toBe(true);
  });
});

describe("resetUnsupportedFilters", () => {
  const baseFilters = {
    from: "2026-07-01", to: "2026-07-31", region: "riyadh", department: "support", facility: "all",
    classificationId: "all", priority: "all", severity: "all", channel: "all", status: "all",
  };

  it("clears a filter the new report type does not support", () => {
    const next = resetUnsupportedFilters(baseFilters, DEPARTMENT_PERFORMANCE_DEFINITION as any);
    expect(next.region).toBe("riyadh"); // supported, preserved
    expect(next.department).toBe("all"); // not supported, cleared
  });

  it("clears the period when switching to a type that doesn't require one", () => {
    const next = resetUnsupportedFilters(baseFilters, CLASSIFICATION_DEFINITION as any);
    expect(next.from).toBe("");
    expect(next.to).toBe("");
  });

  it("keeps or restores a sane period when switching to a type that requires one", () => {
    const next = resetUnsupportedFilters({ ...baseFilters, from: "", to: "" }, EXECUTIVE_SUMMARY_DEFINITION as any);
    expect(next.from).not.toBe("");
    expect(next.to).not.toBe("");
  });
});

describe("buildSupportedFiltersPayload", () => {
  const filters = {
    from: "2026-07-01", to: "2026-07-31", region: "riyadh", department: "support", facility: "all",
    classificationId: "all", priority: "all", severity: "all", channel: "all", status: "all",
  };

  it("omits an unsupported filter from the payload even though it holds a real value", () => {
    const payload = buildSupportedFiltersPayload(filters, DEPARTMENT_PERFORMANCE_DEFINITION as any);
    expect(payload.region).toBe("riyadh");
    expect(payload).not.toHaveProperty("department");
  });

  it("omits from/to entirely when the report type does not require a period", () => {
    const payload = buildSupportedFiltersPayload(filters, CLASSIFICATION_DEFINITION as any);
    expect(payload).not.toHaveProperty("from");
    expect(payload).not.toHaveProperty("to");
  });

  it("includes from/to when the report type requires a period", () => {
    const payload = buildSupportedFiltersPayload(filters, EXECUTIVE_SUMMARY_DEFINITION as any);
    expect(payload.from).toBe("2026-07-01");
    expect(payload.to).toBe("2026-07-31");
  });
});

describe("SectionBody — all section kinds via preview", () => {
  const BASE_REPORT = {
    type: "EXECUTIVE_SUMMARY",
    title: "التقرير التنفيذي الشامل",
    generatedAt: new Date().toISOString(),
    period: { from: "2026-07-01", to: "2026-07-31" },
    filters: {},
    warnings: [],
    rowCount: 0,
  };

  async function renderPreviewWithSections(sections: unknown[]) {
    const user = userEvent.setup();
    const fetchMock = routedFetch({
      "/api/reports/preview": () => jsonResponse({ report: { ...BASE_REPORT, sections } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReportsCenter />);
    const card = await screen.findByText("التقرير التنفيذي الشامل");
    await user.click(card);
    await user.click(screen.getByRole("button", { name: /معاينة/ }));
  }

  it("renders kpi cards", async () => {
    await renderPreviewWithSections([
      {
        id: "kpi_overview", kind: "kpi", title: "المؤشرات الرئيسية",
        cards: [
          { key: "total", label: "إجمالي الشكاوى", value: 1240, format: "number" },
          { key: "pct", label: "نسبة الحل", value: 85, format: "percent" },
        ],
      },
    ]);
    expect(await screen.findByText("إجمالي الشكاوى")).toBeInTheDocument();
    expect(screen.getByText("نسبة الحل")).toBeInTheDocument();
  });

  it("renders table section rows without crashing", async () => {
    await renderPreviewWithSections([
      {
        id: "top_regions", kind: "table", title: "المناطق الأعلى",
        table: {
          id: "top_regions", title: "المناطق الأعلى",
          columns: [{ key: "region", label: "المنطقة" }, { key: "count", label: "العدد", format: "number" }],
          rows: [{ region: "الرياض", count: 320 }, { region: "جدة", count: 210 }],
          truncated: false, totalMatched: 2,
        },
      },
    ]);
    expect(await screen.findByText("الرياض")).toBeInTheDocument();
    expect(screen.getByText("جدة")).toBeInTheDocument();
  });

  it("renders the same defensive matrix truncation fallback as PDF", async () => {
    await renderPreviewWithSections([{
      id: "matrix",
      kind: "matrix",
      title: "مصفوفة الاختبار",
      rowLabel: "الإدارة",
      columnLabel: "التصنيف",
      rowHeaders: ["إدارة أ"],
      columnHeaders: ["تصنيف أ"],
      cells: [[1]],
      rowTotals: [1],
      columnTotals: [1],
      grandTotal: 1,
      totalRows: 1,
      totalColumns: 1,
      truncatedRows: false,
      truncatedColumns: false,
      truncated: true,
      maxRows: 10,
      maxColumns: 10,
    }]);

    expect(await screen.findByText("تم اختصار عرض بيانات المصفوفة."))
      .toBeInTheDocument();
  });

  it("renders text section as a bullet list — crash regression for kind='text'", async () => {
    // Before the fix, section.table.rows.length threw when kind was "text".
    await renderPreviewWithSections([
      {
        id: "exec_summary", kind: "text", title: "الملخص التنفيذي",
        points: ["إجمالي الشكاوى ارتفع بنسبة 12٪", "أعلى منطقة هي الرياض"],
      },
    ]);
    expect(await screen.findByText("الملخص التنفيذي")).toBeInTheDocument();
    expect(screen.getByText("إجمالي الشكاوى ارتفع بنسبة 12٪")).toBeInTheDocument();
    expect(screen.getByText("أعلى منطقة هي الرياض")).toBeInTheDocument();
  });

  it("renders chart section as aggregated totals per series — crash regression for kind='chart'", async () => {
    // Before the fix, section.table.rows.length threw when kind was "chart".
    await renderPreviewWithSections([
      {
        id: "region_trend", kind: "chart", chartType: "line", title: "اتجاه المناطق",
        series: [
          { name: "الرياض", points: [{ x: "2026-07-01", y: 50 }, { x: "2026-07-02", y: 70 }] },
          { name: "جدة", points: [{ x: "2026-07-01", y: 30 }, { x: "2026-07-02", y: 40 }] },
        ],
      },
    ]);
    // Proves the section rendered without crashing and that both series names are visible.
    expect(await screen.findByText("اتجاه المناطق")).toBeInTheDocument();
    expect(screen.getByText("الرياض")).toBeInTheDocument();
    expect(screen.getByText("جدة")).toBeInTheDocument();
  });

  it("renders chart section empty state when series array is empty", async () => {
    await renderPreviewWithSections([
      {
        id: "region_trend", kind: "chart", chartType: "line", title: "اتجاه المناطق",
        series: [], emptyState: "لا توجد بيانات كافية لرسم المخطط",
      },
    ]);
    expect(await screen.findByText("اتجاه المناطق")).toBeInTheDocument();
    expect(screen.getByText("لا توجد بيانات كافية لرسم المخطط")).toBeInTheDocument();
  });

  it("renders text section empty state when points array is empty", async () => {
    await renderPreviewWithSections([
      { id: "exec_summary", kind: "text", title: "الملخص التنفيذي", points: [] },
    ]);
    expect(await screen.findByText("الملخص التنفيذي")).toBeInTheDocument();
    expect(screen.getByText("لا توجد بيانات لعرضها.")).toBeInTheDocument();
  });

  it("renders table section empty state when rows array is empty", async () => {
    await renderPreviewWithSections([
      {
        id: "top_regions", kind: "table", title: "المناطق الأعلى",
        table: {
          id: "top_regions", title: "المناطق الأعلى",
          columns: [{ key: "region", label: "المنطقة" }],
          rows: [], truncated: false, totalMatched: 0,
        },
      },
    ]);
    expect(await screen.findByText("المناطق الأعلى")).toBeInTheDocument();
    expect(screen.getByText("لا توجد بيانات لعرضها.")).toBeInTheDocument();
  });

  it("renders a mixed report with kpi, table, text, and chart sections — no crash", async () => {
    await renderPreviewWithSections([
      {
        id: "kpi_overview", kind: "kpi", title: "المؤشرات الرئيسية",
        cards: [{ key: "total", label: "إجمالي", value: 100, format: "number" }],
      },
      {
        id: "top_regions", kind: "table", title: "المناطق",
        table: {
          id: "top_regions", title: "المناطق",
          columns: [{ key: "region", label: "المنطقة" }],
          rows: [{ region: "الرياض" }], truncated: false, totalMatched: 1,
        },
      },
      { id: "exec_summary", kind: "text", title: "الملخص", points: ["نقطة مهمة"] },
      {
        id: "region_trend", kind: "chart", chartType: "line", title: "الرسم البياني",
        series: [{ name: "الرياض", points: [{ x: "2026-07-01", y: 10 }] }],
      },
    ]);
    expect(await screen.findByText("المؤشرات الرئيسية")).toBeInTheDocument();
    expect(screen.getByText("المناطق")).toBeInTheDocument();
    expect(screen.getByText("الملخص")).toBeInTheDocument();
    expect(screen.getByText("الرسم البياني")).toBeInTheDocument();
  });
});

describe("validatePeriod", () => {
  const filters = {
    from: "2026-07-01", to: "2026-07-31", region: "all", department: "all", facility: "all",
    classificationId: "all", priority: "all", severity: "all", channel: "all", status: "all",
  };

  it("requires from/to for a report type that needs a period", () => {
    expect(validatePeriod(EXECUTIVE_SUMMARY_DEFINITION as any, { ...filters, from: "" })).toMatch(/الفترة/);
  });

  it("rejects from > to", () => {
    expect(
      validatePeriod(EXECUTIVE_SUMMARY_DEFINITION as any, { ...filters, from: "2026-08-01", to: "2026-07-01" })
    ).toMatch(/تاريخ البداية/);
  });

  it("does not require a period for a report type that doesn't need one", () => {
    expect(validatePeriod(CLASSIFICATION_DEFINITION as any, { ...filters, from: "", to: "" })).toBeNull();
  });

  it("passes for a valid period", () => {
    expect(validatePeriod(EXECUTIVE_SUMMARY_DEFINITION as any, filters)).toBeNull();
  });
});
