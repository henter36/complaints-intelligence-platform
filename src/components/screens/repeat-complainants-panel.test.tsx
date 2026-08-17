import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepeatComplainantsPanel } from "./repeat-complainants-panel";
import type { RepeatComplainantSummaryData } from "@/lib/analytics/repeat-complainant-api-contract";
import { formatNumber } from "@/lib/ar-utils";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function summaryFixture(overrides: Partial<RepeatComplainantSummaryData> = {}): RepeatComplainantSummaryData {
  return {
    kpis: {
      repeatedPeopleCount: 3,
      repeatedComplaintsCount: 8,
      repeatedShareOfPeriodPercent: 25,
      topFacility: { facility: "سجن الملز", region: "منطقة الرياض", repeatedPeopleCount: 2 },
      topComplaintType: { label: "التغذية", count: 5 },
    },
    regions: [
      {
        region: "منطقة الرياض",
        repeatedPeopleCount: 3,
        repeatedComplaintsCount: 8,
        facilitiesAffectedCount: 1,
        topComplaintType: { label: "التغذية", count: 5 },
        drilldownFilters: { region: "منطقة الرياض" },
      },
    ],
    facilities: [
      {
        region: "منطقة الرياض",
        facility: "سجن الملز",
        repeatedPeopleCount: 2,
        repeatedComplaintsCount: 6,
        facilityTotalComplaints: 15,
        repeatRatePercent: 40,
        topComplaintType: { label: "التغذية", count: 5 },
        highestRepeatByOnePerson: 4,
        priorityScore: 72,
        priorityBand: "HIGH",
        drilldownFilters: { facility: "سجن الملز", region: "منطقة الرياض" },
        linkedChronicIssue: true,
        linkedMassComplaint: false,
        linkedHighPriorityFacility: true,
      },
    ],
    conclusions: ["أكثر السجون التي يظهر فيها تكرار الشكاوى هو سجن الملز بعدد 2 من الأشخاص المكررين وإجمالي 6 شكوى متكررة."],
    ...overrides,
  };
}

function peopleFixture() {
  return {
    people: [
      {
        complainantIdentifierMasked: "*******4821",
        complainantIdentifierRaw: "1234567894821",
        region: "منطقة الرياض",
        facility: "سجن الملز",
        totalComplaints: 4,
        sameTypeRepeatCount: 4,
        distinctComplaintTypesCount: 1,
        topComplaintTypes: [{ classificationId: "cls-food", label: "التغذية", count: 4 }],
        lastComplaintDate: "2026-02-10",
        periodsPresent: 2,
        spansMultiplePeriods: true,
        pattern: "CONCENTRATED",
        complaintIds: ["c1", "c2", "c3", "c4"],
        drilldownFilters: { complainantIdentifier: "1234567894821", facility: "سجن الملز", region: "منطقة الرياض" },
      },
    ],
    total: 1,
    page: 1,
    pageSize: 25,
  };
}

function stubFetch(handlers: {
  summary?: () => Response | Promise<Response>;
  people?: () => Response | Promise<Response>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/analytics/repeat-complainants/people")) {
        return handlers.people ? handlers.people() : jsonResponse(peopleFixture());
      }
      if (url.includes("/api/analytics/repeat-complainants")) {
        return handlers.summary ? handlers.summary() : jsonResponse(summaryFixture());
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
}


async function findFacilityRow() {
  return screen.findByRole("row", { name: /سجن الملز/ });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RepeatComplainantsPanel", () => {
  it("renders KPI cards, the facility table, and executive conclusions from the summary response", async () => {
    stubFetch({});
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);

    await findFacilityRow();
    // The label also appears as the sort-dropdown trigger's current value, so allow multiple matches.
    expect(screen.getAllByText("عدد الأشخاص المكررين").length).toBeGreaterThan(0);
    expect(screen.getByText(formatNumber(3))).toBeInTheDocument(); // repeatedPeopleCount KPI value
    expect(screen.getByText(/أكثر السجون التي يظهر فيها تكرار الشكاوى/)).toBeInTheDocument();
  });

  it("never renders the raw complainant identifier anywhere, only the masked form", async () => {
    stubFetch({});
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);

    await findFacilityRow();
    await user.click(await findFacilityRow());

    await waitFor(() => {
      expect(screen.getByText("*******4821")).toBeInTheDocument();
    });
    expect(screen.queryByText("1234567894821")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("1234567894821");
  });

  it("lazily fetches the per-facility people list only when a facility row is expanded", async () => {
    const peopleSpy = vi.fn(() => jsonResponse(peopleFixture()));
    stubFetch({ people: peopleSpy });
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);

    await findFacilityRow();
    expect(peopleSpy).not.toHaveBeenCalled();

    await user.click(await findFacilityRow());
    await waitFor(() => expect(peopleSpy).toHaveBeenCalledTimes(1));
  });

  it("shows chronic-issue / high-priority-facility badges reused from the pattern-analysis engine integration", async () => {
    stubFetch({});
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    await findFacilityRow();
    expect(screen.getByText("مشكلة مزمنة")).toBeInTheDocument();
    expect(screen.getByText("أولوية مرتفعة")).toBeInTheDocument();
    expect(screen.queryByText("انتشار جماعي")).not.toBeInTheDocument();
  });

  it("calls onNavigateToExplorer with the facility's drilldown filters when its drill button is clicked", async () => {
    stubFetch({});
    const onNavigateToExplorer = vi.fn();
    const user = userEvent.setup();
    render(
      <RepeatComplainantsPanel
        from="2026-01-01"
        to="2026-03-01"
        regionId="all"
        onNavigateToExplorer={onNavigateToExplorer}
      />
    );
    await findFacilityRow();

    const drillButtons = screen.getAllByRole("button", { name: /عرض الشكاوى/ });
    await user.click(drillButtons[0]!);

    expect(onNavigateToExplorer).toHaveBeenCalledWith(
      expect.objectContaining({
        facility: "سجن الملز",
        region: "منطقة الرياض",
        from: "2026-01-01",
        to: "2026-03-01",
      })
    );
  });

  it("drills through a specific person with their raw complainantIdentifier in the query, never rendering it", async () => {
    stubFetch({});
    const onNavigateToExplorer = vi.fn();
    const user = userEvent.setup();
    render(
      <RepeatComplainantsPanel
        from="2026-01-01"
        to="2026-03-01"
        regionId="all"
        onNavigateToExplorer={onNavigateToExplorer}
      />
    );
    await findFacilityRow();
    await user.click(await findFacilityRow());
    await waitFor(() => expect(screen.getByText("*******4821")).toBeInTheDocument());

    const personDrillButtons = screen.getAllByRole("button", { name: /عرض الشكاوى/ });
    // Last drill button belongs to the expanded person row.
    await user.click(personDrillButtons.at(-1)!);

    expect(onNavigateToExplorer).toHaveBeenCalledWith(
      expect.objectContaining({ complainantIdentifier: "1234567894821", facility: "سجن الملز" })
    );
  });

  it("shows a friendly empty state instead of a broken table when there is no repeated-complainant data", async () => {
    stubFetch({ summary: () => jsonResponse(summaryFixture({ facilities: [], regions: [], conclusions: [] })) });
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    await waitFor(() => {
      expect(screen.getByText("لا يوجد تكرار شكاوى للفترة والفلاتر الحالية.")).toBeInTheDocument();
    });
  });

  it("surfaces a load error without crashing when the API responds with an error payload", async () => {
    stubFetch({
      summary: () => jsonResponse({ error: { code: "REPEAT_COMPLAINANTS_FAILED", message: "تعذر جلب تحليل تكرار الشكاوى" } }, 500),
    });
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    await waitFor(() => {
      expect(screen.getByText("تعذر جلب تحليل تكرار الشكاوى")).toBeInTheDocument();
    });
  });

  it("never renders NaN or Infinity for any KPI or table value", async () => {
    stubFetch({});
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    await findFacilityRow();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Infinity/)).not.toBeInTheDocument();
  });

  it("does not fetch on mount before the tab is actually shown is out of scope here; ensures the region filter is included in the summary request", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/people")) return jsonResponse(peopleFixture());
      return jsonResponse(summaryFixture());
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="منطقة الرياض" />);
    await findFacilityRow();
    const summaryCall = fetchSpy.mock.calls.find(([input]) => !String(input).includes("/people"));
    expect(String(summaryCall![0])).toContain("regionId=");
  });

  it("re-fetches when the local minComplaints/sameTypeOnly filters change", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/people")) return jsonResponse(peopleFixture());
      return jsonResponse(summaryFixture());
    });
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    await findFacilityRow();

    const callsBefore = fetchSpy.mock.calls.length;
    const checkbox = screen.getByLabelText("نفس النوع فقط");
    await user.click(checkbox);

    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore));
    const lastSummaryCall = fetchSpy.mock.calls
      .filter(([input]) => !String(input).includes("/people"))
      .at(-1)!;
    expect(String(lastSummaryCall[0])).toContain("sameTypeOnly=true");
  });
});

describe("RepeatComplainantsPanel — table structure", () => {
  it("puts the facility row inside a table with the expected columns", async () => {
    stubFetch({});
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    const facilityRow = await findFacilityRow();
    const table = facilityRow.closest("table")!;
    const headerRow = within(table).getAllByRole("row")[0]!;
    expect(within(headerRow).getByText("المنطقة")).toBeInTheDocument();
    expect(within(headerRow).getByText("الأشخاص المكررون")).toBeInTheDocument();
    expect(within(headerRow).getByText("نسبة التكرار")).toBeInTheDocument();
  });
});
