import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Home from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  redirect: vi.fn(),
}));
vi.mock("@/components/screens/dashboard", () => ({
  Dashboard: () => <div>Dashboard screen</div>,
}));
vi.mock("@/components/screens/import-center", () => ({
  ImportCenter: () => <div>Import center screen</div>,
}));
vi.mock("@/components/screens/complaints-explorer", () => ({
  ComplaintsExplorer: () => <div>Complaints explorer screen: {window.location.search}</div>,
}));
vi.mock("@/components/screens/analytics", () => ({
  Analytics: ({ onNavigateToExplorer }: { onNavigateToExplorer?: (query: Record<string, string>) => void }) => (
    <div>
      Analytics screen
      <button onClick={() => onNavigateToExplorer?.({ facility: "سجن أ" })}>عرض الشكاوى المرتبطة (test)</button>
    </div>
  ),
}));
vi.mock("@/components/screens/reports-center", () => ({
  ReportsCenter: () => <div>Reports screen</div>,
}));
vi.mock("@/components/screens/classifications-manager", () => ({
  ClassificationsManager: () => <div>Classifications screen</div>,
}));
vi.mock("@/components/screens/import-log", () => ({
  ImportLog: () => <div>Import log screen</div>,
}));
vi.mock("@/components/screens/ai-analysis", () => ({
  AiAnalysis: () => <div>AI analysis screen</div>,
}));
vi.mock("@/server/auth/session-service", () => ({
  getCurrentAdminSessionFromCookies: vi.fn().mockResolvedValue({ id: "session_test", username: "admin" }),
}));

describe("Home page smoke", () => {
  it("renders the home screen and sidebar", async () => {
    render(await Home());

    expect(await screen.findByText("نظام الشكاوى")).toBeInTheDocument();
    expect(screen.getByText("الشاشة الرئيسية")).toBeInTheDocument();
    expect(screen.getByText("Dashboard screen")).toBeInTheDocument();
  });

  it("navigates between primary screens", async () => {
    const user = userEvent.setup();
    render(await Home());

    await user.click(screen.getByText("مركز الاستيراد"));

    expect(screen.getByText("Import center screen")).toBeInTheDocument();
  });

  it("drills down from Analytics into the explorer with the finding's filters applied via a real URL", async () => {
    const user = userEvent.setup();
    render(await Home());

    await user.click(screen.getByText("التحليلات"));
    expect(screen.getByText("Analytics screen")).toBeInTheDocument();

    await user.click(screen.getByText("عرض الشكاوى المرتبطة (test)"));

    expect(await screen.findByText(/Complaints explorer screen:/)).toBeInTheDocument();
    expect(window.location.search).toContain("facility=");
    expect(window.location.search).toContain("screen=explorer");
  });

  it("Back after a drilldown returns to the previous screen (real history entry, not replaceState)", async () => {
    const user = userEvent.setup();
    render(await Home());

    await user.click(screen.getByText("التحليلات"));
    await user.click(screen.getByText("عرض الشكاوى المرتبطة (test)"));
    expect(await screen.findByText(/Complaints explorer screen:/)).toBeInTheDocument();

    window.history.back();
    await screen.findByText("Analytics screen");
  });
});
