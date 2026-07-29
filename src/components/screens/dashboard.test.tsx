import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard";

describe("Dashboard smoke", () => {
  it("shows loading skeletons while dashboard data is loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    const { container } = render(<Dashboard onNavigate={vi.fn()} />);

    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });
});
