import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Home from "./page";

vi.mock("@/components/screens/dashboard", () => ({
  Dashboard: () => <div>Dashboard screen</div>,
}));
vi.mock("@/components/screens/import-center", () => ({
  ImportCenter: () => <div>Import center screen</div>,
}));
vi.mock("@/components/screens/complaints-explorer", () => ({
  ComplaintsExplorer: () => <div>Complaints explorer screen</div>,
}));
vi.mock("@/components/screens/analytics", () => ({
  Analytics: () => <div>Analytics screen</div>,
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

describe("Home page smoke", () => {
  it("renders the home screen and sidebar", async () => {
    render(<Home />);

    expect(await screen.findByText("نظام الشكاوى")).toBeInTheDocument();
    expect(screen.getByText("الشاشة الرئيسية")).toBeInTheDocument();
    expect(screen.getByText("Dashboard screen")).toBeInTheDocument();
  });

  it("navigates between primary screens", async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.click(screen.getByText("مركز الاستيراد"));

    expect(screen.getByText("Import center screen")).toBeInTheDocument();
  });
});
