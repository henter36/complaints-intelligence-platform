import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastSpy = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import {
  ClassificationsManager,
  ImportedDetailPicker,
} from "./classifications-manager";

const treePayload = [
  {
    id: "cat_1",
    nodeType: "CATEGORY",
    name: "فئة رئيسية",
    description: "وصف الفئة",
    parentId: null,
    children: [
      {
        id: "cls_1",
        nodeType: "CLASSIFICATION",
        name: "تصنيف فرعي",
        description: "وصف التصنيف",
        color: "#10b981",
        keywords: ["قديمة"],
        parentId: "cat_1",
      },
    ],
  },
];

const listPayload = {
  items: [
    {
      normalizedValue: "وكاله",
      displayValue: "وكالة",
      occurrences: 37,
      linkedKeywordsCount: 0,
      alreadyLinkedToCurrentClassification: false,
      linkedToOtherClassification: false,
    },
    {
      normalizedValue: "طلب علاج",
      displayValue: "طلب علاج",
      occurrences: 4,
      linkedKeywordsCount: 1,
      alreadyLinkedToCurrentClassification: false,
      linkedToOtherClassification: true,
      linkedClassificationName: "تصنيف آخر",
    },
  ],
  page: 1,
  pageSize: 20,
  total: 2,
  availableTotal: 2,
};

function jsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => data,
  };
}

describe("ImportedDetailPicker draft mode", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("disables linked-to-other values and adds draft without keywords/import", async () => {
    const onSelect = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(listPayload));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <ImportedDetailPicker
        classificationId="cls_1"
        existingKeywords={["قديمة"]}
        onSelect={onSelect}
      />
    );

    expect(await screen.findByText("وكالة")).toBeInTheDocument();
    expect(screen.getByText("مرتبطة: تصنيف آخر")).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[2]).toBeDisabled();

    await user.click(checkboxes[1]);
    await user.click(screen.getByRole("button", { name: "إضافة المحدد إلى المسودة" }));
    expect(onSelect).toHaveBeenCalledWith(["وكالة"]);
    expect(
      fetchMock.mock.calls.some(([url, init]) =>
        String(url).includes("/keywords/import")
        && (init as RequestInit | undefined)?.method === "POST"
      )
    ).toBe(false);
  });

  it("keeps selections when paging", async () => {
    const page1 = {
      ...listPayload,
      items: [listPayload.items[0]],
      total: 40,
    };
    const page2 = {
      ...listPayload,
      items: [listPayload.items[1]],
      page: 2,
      total: 40,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("page=2")) return jsonResponse(page2);
      return jsonResponse(page1);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <ImportedDetailPicker
        classificationId="cls_1"
        existingKeywords={[]}
        onSelect={vi.fn()}
      />
    );
    await screen.findByText("وكالة");
    await user.click(screen.getAllByRole("checkbox")[1]);
    expect(screen.getByText(/تم اختيار [1١] قيمة/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "التالي" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("page=2"))
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText("طلب علاج")).toBeInTheDocument();
    });
    expect(screen.getByText(/تم اختيار [1١] قيمة/)).toBeInTheDocument();
  });
});

describe("ClassificationsManager", () => {
  beforeEach(() => {
    toastSpy.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function mockTreeFetch(overrides?: {
    onMutate?: (
      url: string,
      init?: RequestInit
    ) => { ok: boolean; status: number; json: () => Promise<unknown> };
    tree?: unknown;
  }) {
    const tree = overrides?.tree ?? treePayload;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/dashboard")) {
        return jsonResponse({ distributions: { byClassification: [] } });
      }
      if (url.includes("/api/classifications/imported-detail-values")) {
        return jsonResponse(listPayload);
      }
      if (init?.method && init.method !== "GET") {
        if (overrides?.onMutate) {
          return overrides.onMutate(url, init);
        }
        return jsonResponse({ id: "ok" });
      }
      if (url.includes("/api/classifications")) {
        return jsonResponse(tree);
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function renderManager() {
    await act(async () => {
      render(<ClassificationsManager />);
    });
    expect(await screen.findByText("تصنيف فرعي")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "فئة رئيسية" })).toBeInTheDocument();
  }

  it("hides merge button", async () => {
    mockTreeFetch();
    await renderManager();
    expect(screen.queryByRole("button", { name: /دمج التصنيفات/ })).not.toBeInTheDocument();
  });

  it("opens category editor without keywords or color", async () => {
    mockTreeFetch();
    await renderManager();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("edit-node-cat_1"));

    expect(await screen.findByRole("heading", { name: "تعديل الفئة الرئيسية" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/اكتب كلمة مفتاحية/)).not.toBeInTheDocument();
    expect(screen.queryByText("القيم المستوردة من «تفصيل»")).not.toBeInTheDocument();
    expect(screen.queryByText("زمردي")).not.toBeInTheDocument();
  });

  it("classification dialog shows keywords and saves via PATCH", async () => {
    const fetchMock = mockTreeFetch({
      onMutate: (url, init) => {
        expect(url).toContain("/api/classifications/cls_1");
        expect(init?.method).toBe("PATCH");
        const body = JSON.parse(String(init?.body));
        expect(body.keywords).toEqual(expect.arrayContaining(["قديمة", "يدوية"]));
        return jsonResponse({
          id: "cls_1",
          nodeType: "CLASSIFICATION",
          keywords: body.keywords,
        });
      },
    });
    await renderManager();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("edit-node-cls_1"));

    expect(await screen.findByRole("heading", { name: "تعديل التصنيف" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/اكتب كلمة مفتاحية/)).toBeInTheDocument();
    const keywordInput = screen.getByPlaceholderText(/اكتب كلمة مفتاحية/);
    await user.type(keywordInput, "يدوية");
    await user.click(screen.getByRole("button", { name: /^إضافة$/ }));
    await user.click(screen.getByRole("button", { name: "حفظ التغييرات" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/classifications/cls_1")
            && (init as RequestInit | undefined)?.method === "PATCH"
        )
      ).toBe(true);
    });
  });

  it("adds imported values to draft without POST import", async () => {
    const fetchMock = mockTreeFetch();
    await renderManager();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("edit-node-cls_1"));
    await screen.findByRole("heading", { name: "تعديل التصنيف" });
    await user.click(screen.getByRole("tab", { name: /القيم المستوردة/ }));
    await screen.findByText("وكالة");
    const boxes = screen.getAllByRole("checkbox");
    await user.click(boxes[1]);
    await user.click(screen.getByRole("button", { name: "إضافة المحدد إلى المسودة" }));
    expect(
      fetchMock.mock.calls.some(([url, init]) =>
        String(url).includes("/keywords/import")
        && (init as RequestInit | undefined)?.method === "POST"
      )
    ).toBe(false);
  });

  it("cancel after selecting imported value causes no mutation", async () => {
    const fetchMock = mockTreeFetch();
    await renderManager();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("edit-node-cls_1"));
    await user.click(await screen.findByRole("tab", { name: /القيم المستوردة/ }));
    await screen.findByText("وكالة");
    await user.click(screen.getAllByRole("checkbox")[1]);
    await user.click(screen.getByRole("button", { name: "إضافة المحدد إلى المسودة" }));
    await user.click(screen.getByRole("button", { name: "إلغاء" }));

    const mutations = fetchMock.mock.calls.filter(([, init]) => {
      const method = (init as RequestInit | undefined)?.method;
      return method && method !== "GET";
    });
    expect(mutations).toHaveLength(0);
  });

  it("API error keeps dialog open", async () => {
    mockTreeFetch({
      onMutate: () =>
        jsonResponse(
          { error: { code: "X", message: "فشل التحقق" } },
          false,
          400
        ),
    });
    await renderManager();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("edit-node-cat_1"));
    await screen.findByRole("heading", { name: "تعديل الفئة الرئيسية" });
    await user.click(screen.getByRole("button", { name: "حفظ التغييرات" }));
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "خطأ في الحفظ",
          description: "فشل التحقق",
        })
      );
    });
    expect(screen.getByRole("heading", { name: "تعديل الفئة الرئيسية" })).toBeInTheDocument();
  });
});
