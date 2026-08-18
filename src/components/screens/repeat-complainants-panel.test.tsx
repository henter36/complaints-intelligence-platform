import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function personFixture(overrides: Partial<ReturnType<typeof basePersonFixture>> = {}) {
  return { ...basePersonFixture(), ...overrides };
}

function basePersonFixture() {
  return {
    complainantIdentifierMasked: "*******4821",
    complainantToken: "opaque-token-abc",
    complainantName: "محمد أحمد",
    region: "منطقة الرياض",
    facility: "سجن الملز",
    facilitiesCount: 1,
    facilities: [{ region: "منطقة الرياض", facility: "سجن الملز", complaintsCount: 4 }],
    totalComplaints: 4,
    sameTypeRepeatCount: 4,
    distinctComplaintTypesCount: 1,
    topComplaintTypes: [{ classificationId: "cls-food", label: "التغذية", count: 4 }],
    firstComplaintDate: "2026-01-05",
    lastComplaintDate: "2026-02-10",
    periodsPresent: 2,
    spansMultiplePeriods: true,
    recentActivity: false,
    pattern: "CONCENTRATED",
    complaintIds: ["c1", "c2", "c3", "c4"],
    drilldownFilters: { facility: "سجن الملز", region: "منطقة الرياض" },
  };
}

function peopleFixture() {
  return { people: [personFixture()], total: 1, page: 1, pageSize: 25 };
}

function personDetailFixture() {
  return {
    person: personFixture(),
    complaints: [
      {
        complaintId: "c1",
        complaintNumber: "v1",
        date: "2026-02-10",
        region: "منطقة الرياض",
        facility: "سجن الملز",
        classificationId: "cls-food",
        classificationLabel: "التغذية",
        subject: "شكوى غذائية",
        descriptionSnippet: null,
        status: "OPEN",
        monthKey: "2026-02",
      },
    ],
    complaintsByType: [
      { classificationId: "cls-food", label: "التغذية", complaints: [] },
    ],
    timeline: [{ monthKey: "2026-02", monthLabel: "فبراير 2026", count: 4 }],
  };
}

function stubFetch(handlers: {
  summary?: () => Response | Promise<Response>;
  people?: () => Response | Promise<Response>;
  person?: () => Response | Promise<Response>;
  search?: () => Response | Promise<Response>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repeat-complainants/search")) {
        return handlers.search ? handlers.search() : jsonResponse({ people: [] });
      }
      if (url.includes("/repeat-complainants/person")) {
        return handlers.person ? handlers.person() : jsonResponse(personDetailFixture());
      }
      if (url.includes("/repeat-complainants/people")) {
        return handlers.people ? handlers.people() : jsonResponse(peopleFixture());
      }
      if (url.includes("/api/analytics/repeat-complainants")) {
        return handlers.summary ? handlers.summary() : jsonResponse(summaryFixture());
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
}

async function expandRegion(user: ReturnType<typeof userEvent.setup>) {
  const regionButton = await screen.findByRole("button", { name: /منطقة الرياض/ });
  await user.click(regionButton);
  return screen.findByRole("row", { name: /سجن الملز/ });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RepeatComplainantsPanel", () => {
  it("renders KPI cards and executive conclusions from the summary response", async () => {
    stubFetch({});
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);

    await screen.findByRole("button", { name: /منطقة الرياض/ });
    expect(screen.getByText(formatNumber(3))).toBeInTheDocument(); // repeatedPeopleCount KPI value
    expect(screen.getByText(/أكثر السجون التي يظهر فيها تكرار الشكاوى/)).toBeInTheDocument();
  });

  it("expands a region to reveal its facilities, then a facility to reveal its people", async () => {
    stubFetch({});
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);

    expect(screen.queryByText("سجن الملز")).not.toBeInTheDocument();
    const facilityRow = await expandRegion(user);
    await user.click(facilityRow);

    await screen.findByText("محمد أحمد");
  });

  it("never renders the raw complainant identifier anywhere, only the masked form", async () => {
    stubFetch({});
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);

    const facilityRow = await expandRegion(user);
    await user.click(facilityRow);

    await waitFor(() => {
      expect(screen.getByText("*******4821")).toBeInTheDocument();
    });
    expect(document.body.innerHTML).not.toContain("1234567894821");
  });

  it("lazily fetches the per-facility people list only when a facility row is expanded", async () => {
    const peopleSpy = vi.fn(() => jsonResponse(peopleFixture()));
    stubFetch({ people: peopleSpy });
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);

    const facilityRow = await expandRegion(user);
    expect(peopleSpy).not.toHaveBeenCalled();

    await user.click(facilityRow);
    await waitFor(() => expect(peopleSpy).toHaveBeenCalledTimes(1));
  });

  it("shows chronic-issue / high-priority-facility badges reused from the pattern-analysis engine integration", async () => {
    stubFetch({});
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    await expandRegion(user);
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
    await expandRegion(user);

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

  it("opens the person detail sheet with an opaque token, never the raw identifier, and drills through via complainantToken", async () => {
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
    const facilityRow = await expandRegion(user);
    await user.click(facilityRow);
    await screen.findByText("محمد أحمد");

    await user.click(screen.getByRole("button", { name: "عرض التكرارات" }));

    await screen.findByText("ملخص التكرار");
    // The opaque token traveled in the request URL — never the raw identifier.
    const personCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("/repeat-complainants/person?")
    );
    expect(String(personCall![0])).toContain("token=opaque-token-abc");
    expect(String(personCall![0])).not.toContain("1234567894821");

    // "عرض كل شكاوى هذا الشخص" is org-wide (spec §12) — it must NOT restrict
    // to the one facility this sheet happened to be opened from.
    await user.click(screen.getByRole("button", { name: /عرض كل شكاوى هذا الشخص/ }));
    expect(onNavigateToExplorer).toHaveBeenCalledWith(
      expect.objectContaining({ complainantToken: "opaque-token-abc" })
    );
    expect(onNavigateToExplorer).not.toHaveBeenCalledWith(expect.objectContaining({ facility: expect.anything() }));
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
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    await expandRegion(user);
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Infinity/)).not.toBeInTheDocument();
  });

  it("ensures the region filter is included in the summary request", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/people")) return jsonResponse(peopleFixture());
      return jsonResponse(summaryFixture());
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="منطقة الرياض" />);
    await screen.findByRole("button", { name: /منطقة الرياض/ });
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
    await screen.findByRole("button", { name: /منطقة الرياض/ });

    const callsBefore = fetchSpy.mock.calls.length;
    const checkbox = screen.getByLabelText("نفس النوع فقط");
    await user.click(checkbox);

    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore));
    const lastSummaryCall = fetchSpy.mock.calls
      .filter(([input]) => !String(input).includes("/people"))
      .at(-1)!;
    expect(String(lastSummaryCall[0])).toContain("sameTypeOnly=true");
  });

  it("shows the person's name when the source recorded one, and never fabricates a name when absent", async () => {
    stubFetch({
      people: () =>
        jsonResponse({
          people: [{ ...personFixture(), complainantName: null, complainantToken: "tok-2" }],
          total: 1,
          page: 1,
          pageSize: 25,
        }),
    });
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    const facilityRow = await expandRegion(user);
    await user.click(facilityRow);
    await screen.findByText("غير متوفر");
  });

  it("searches org-wide via POST (never a GET query string) and shows results without the local facility scope", async () => {
    const searchSpy = vi.fn(() => jsonResponse({ people: [personFixture()] }));
    stubFetch({ search: searchSpy });
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    await screen.findByRole("button", { name: /منطقة الرياض/ });

    await user.type(screen.getByLabelText(/البحث بالاسم/), "محمد");

    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("/search")
    )! as [RequestInfo | URL, RequestInit];
    expect(init.method).toBe("POST");
    expect(String(init.body)).not.toContain("undefined");
    await screen.findByText("محمد أحمد");
  });
});

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("RepeatComplainantsPanel — request races (spec §5/§6)", () => {
  it("shows person B's detail, never stale A's, when B is opened before A resolves and A's response arrives LAST", async () => {
    const personA = personFixture({ complainantToken: "token-a", complainantName: "شخص أ" });
    const personB = personFixture({ complainantToken: "token-b", complainantName: "شخص ب" });
    const detailA = { ...personDetailFixture(), person: personA };
    const detailB = { ...personDetailFixture(), person: personB };
    const deferredA = deferredResponse();
    const deferredB = deferredResponse();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/repeat-complainants/person?")) {
          return url.includes("token=token-a") ? deferredA.promise : deferredB.promise;
        }
        if (url.includes("/repeat-complainants/people")) {
          return jsonResponse({ people: [personA, personB], total: 2, page: 1, pageSize: 25 });
        }
        return jsonResponse(summaryFixture());
      })
    );

    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    const facilityRow = await expandRegion(user);
    await user.click(facilityRow);
    await screen.findByText("شخص أ");

    const detailButtons = screen.getAllByRole("button", { name: "عرض التكرارات" });
    await user.click(detailButtons[0]!); // opens A
    // The now-open Sheet overlays the underlying table (pointer-events: none
    // on the background), same as it would for a real second click target
    // (e.g. a search result) opened while A is still loading — fireEvent
    // bypasses that overlay hit-test since this test targets the request-
    // race guard itself, not click-through accessibility.
    fireEvent.click(detailButtons[1]!); // opens B before A's response arrives

    // B resolves first...
    deferredB.resolve(jsonResponse(detailB));
    await screen.findByText("ملخص التكرار");
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("شخص ب")).toBeInTheDocument();

    // ...then A's (now-stale) response arrives LAST — it must be ignored.
    // "شخص أ" legitimately still exists in the (overlaid) background table
    // row, so the assertion is scoped to the Sheet's own content only.
    deferredA.resolve(jsonResponse(detailA));
    await new Promise((r) => setTimeout(r, 0));
    expect(within(sheet).getByText("شخص ب")).toBeInTheDocument();
    expect(within(sheet).queryByText("شخص أ")).not.toBeInTheDocument();
  });

  it("never applies a person-detail response that resolves after the component has unmounted", async () => {
    const deferredPerson = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/repeat-complainants/person?")) return deferredPerson.promise;
        if (url.includes("/repeat-complainants/people")) return jsonResponse(peopleFixture());
        return jsonResponse(summaryFixture());
      })
    );
    const user = userEvent.setup();
    const { unmount } = render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    const facilityRow = await expandRegion(user);
    await user.click(facilityRow);
    await screen.findByText("محمد أحمد");
    await user.click(screen.getByRole("button", { name: "عرض التكرارات" }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    unmount();
    deferredPerson.resolve(jsonResponse(personDetailFixture()));
    await new Promise((r) => setTimeout(r, 0));

    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("unmounted"));
    errorSpy.mockRestore();
  });

  it("cancels the in-flight per-facility people fetch when the region/period filters change, so a late response cannot resurrect stale data", async () => {
    const deferredPeople = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/repeat-complainants/people")) return deferredPeople.promise;
        return jsonResponse(summaryFixture());
      })
    );
    const user = userEvent.setup();
    const { rerender } = render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    const facilityRow = await expandRegion(user);
    await user.click(facilityRow); // fires the people fetch, left pending

    // Change scope (e.g. the period) before the people fetch resolves.
    rerender(<RepeatComplainantsPanel from="2026-04-01" to="2026-06-01" regionId="all" />);

    await act(async () => {
      deferredPeople.resolve(jsonResponse(peopleFixture()));
      await new Promise((r) => setTimeout(r, 0));
    });

    // The stale people response must not have repopulated the (reset) cache/UI.
    expect(screen.queryByText("محمد أحمد")).not.toBeInTheDocument();
  });
});

describe("RepeatComplainantsPanel — cross-facility person (spec §1/§11/§12/§18)", () => {
  it("shows a facility-breakdown table and both drill options for a person who appears at more than one facility", async () => {
    const multiFacilityPerson = personFixture({
      facilitiesCount: 2,
      facilities: [
        { region: "منطقة الرياض", facility: "سجن الملز", complaintsCount: 3 },
        { region: "منطقة مكة المكرمة", facility: "سجن مكة", complaintsCount: 1 },
      ],
    });
    stubFetch({
      people: () => jsonResponse({ people: [multiFacilityPerson], total: 1, page: 1, pageSize: 25 }),
      person: () =>
        jsonResponse({
          ...personDetailFixture(),
          person: multiFacilityPerson,
        }),
    });
    const onNavigateToExplorer = vi.fn();
    const user = userEvent.setup();
    render(
      <RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" onNavigateToExplorer={onNavigateToExplorer} />
    );
    const facilityRow = await expandRegion(user);
    await user.click(facilityRow);
    await screen.findByText("محمد أحمد");
    await user.click(screen.getByRole("button", { name: "عرض التكرارات" }));

    await screen.findByText("توزيع الشكاوى حسب السجن");
    expect(screen.getByText("سجن مكة")).toBeInTheDocument();

    // Org-wide button carries no facility restriction.
    await user.click(screen.getByRole("button", { name: "عرض كل شكاوى هذا الشخص" }));
    expect(onNavigateToExplorer).toHaveBeenLastCalledWith(
      expect.objectContaining({ complainantToken: "opaque-token-abc" })
    );
    expect(onNavigateToExplorer.mock.calls.at(-1)![0]).not.toHaveProperty("facility");

    // The facility-scoped button restricts to the facility this sheet was opened from.
    await user.click(screen.getByRole("button", { name: /عرض شكاواه في سجن الملز/ }));
    expect(onNavigateToExplorer).toHaveBeenLastCalledWith(
      expect.objectContaining({ complainantToken: "opaque-token-abc", facility: "سجن الملز" })
    );
  });

  it("does not show the per-facility drill button for a single-facility person", async () => {
    stubFetch({});
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    const facilityRow = await expandRegion(user);
    await user.click(facilityRow);
    await screen.findByText("محمد أحمد");
    await user.click(screen.getByRole("button", { name: "عرض التكرارات" }));

    await screen.findByText("ملخص التكرار");
    expect(screen.queryByText(/عرض شكاواه في/)).not.toBeInTheDocument();
    expect(screen.queryByText("توزيع الشكاوى حسب السجن")).not.toBeInTheDocument();
  });

  it("opens org-wide detail (no facility restriction) when a person is selected from org-wide search results", async () => {
    const searchToken = { ...personFixture(), complainantToken: "search-token" };
    stubFetch({
      search: () => jsonResponse({ people: [searchToken] }),
      person: () => jsonResponse({ ...personDetailFixture(), person: searchToken }),
    });
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    await screen.findByRole("button", { name: /منطقة الرياض/ });

    await user.type(screen.getByLabelText(/البحث بالاسم/), "محمد");
    await waitFor(() => expect(screen.getByRole("button", { name: "عرض التكرارات" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "عرض التكرارات" }));

    await waitFor(() => {
      const personCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("/repeat-complainants/person?")
      );
      expect(personCall).toBeDefined();
      expect(String(personCall![0])).not.toContain("facility=");
    });
  });
});

describe("RepeatComplainantsPanel — table structure", () => {
  it("puts the facility row inside a table with the expected columns", async () => {
    stubFetch({});
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    const facilityRow = await expandRegion(user);
    const table = facilityRow.closest("table")!;
    const headerRow = within(table).getAllByRole("row")[0]!;
    expect(within(headerRow).getByText("السجن")).toBeInTheDocument();
    expect(within(headerRow).getByText("الأشخاص المكررون")).toBeInTheDocument();
    expect(within(headerRow).getByText("نسبة التكرار")).toBeInTheDocument();
  });

  it("puts each person row inside a table with the spec's main-table columns", async () => {
    stubFetch({});
    const user = userEvent.setup();
    render(<RepeatComplainantsPanel from="2026-01-01" to="2026-03-01" regionId="all" />);
    const facilityRow = await expandRegion(user);
    await user.click(facilityRow);
    const personName = await screen.findByText("محمد أحمد");
    const table = personName.closest("table")!;
    const headerRow = within(table).getAllByRole("row")[0]!;
    for (const label of ["الاسم", "الهوية", "المنطقة", "السجن", "عدد الشكاوى", "أنواع الشكاوى", "الأكثر تكراراً", "آخر شكوى", "التفاصيل"]) {
      expect(within(headerRow).getByText(label)).toBeInTheDocument();
    }
  });
});
