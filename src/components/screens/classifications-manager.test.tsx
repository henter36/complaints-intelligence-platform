import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportedDetailPicker } from "./classifications-manager";

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
    },
  ],
  page: 1,
  pageSize: 20,
  total: 2,
};

describe("imported detail keyword picker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows normalized values, occurrences, link state, and keeps add disabled without selection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => listPayload }));
    render(<ImportedDetailPicker classificationId="cls_1" onImported={vi.fn()} />);

    expect(await screen.findByText("وكالة")).toBeInTheDocument();
    expect(screen.getByText(/٣٧\s*ظهور/)).toBeInTheDocument();
    expect(screen.getByText("مرتبطة بتصنيف آخر")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إضافة المحدد ككلمات مفتاحية" })).toBeDisabled();
  });

  it("supports multi-selection and refreshes current keywords after a successful add", async () => {
    const onImported = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => listPayload })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ added: 2, alreadyExists: 0, keywords: ["وكالة", "طلب علاج"] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => listPayload });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ImportedDetailPicker classificationId="cls_1" onImported={onImported} />);

    await screen.findByText("وكالة");
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]);
    await user.click(checkboxes[2]);
    await user.click(screen.getByRole("button", { name: "إضافة المحدد ككلمات مفتاحية" }));

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(["وكالة", "طلب علاج"]));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/classifications/cls_1/keywords/import",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("searches server-side and preserves the selection when adding fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => listPayload })
      .mockResolvedValueOnce({ ok: true, json: async () => listPayload })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: "هذه الكلمة مرتبطة حاليًا بتصنيف آخر." } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ImportedDetailPicker classificationId="cls_1" onImported={vi.fn()} />);

    await screen.findByText("وكالة");
    await user.type(screen.getByRole("textbox", { name: "البحث في قيم تفصيل" }), "وكالة");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("search="))).toBe(true));

    const itemCheckbox = screen.getAllByRole("checkbox")[1];
    await user.click(itemCheckbox);
    await user.click(screen.getByRole("button", { name: "إضافة المحدد ككلمات مفتاحية" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "إضافة المحدد ككلمات مفتاحية" })).not.toBeDisabled());
    expect(itemCheckbox).toBeChecked();
  });
});
