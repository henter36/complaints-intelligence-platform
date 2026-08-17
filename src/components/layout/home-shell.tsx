"use client";

import { useCallback, useEffect, useState } from "react";
import { Dashboard } from "@/components/screens/dashboard";
import { ImportCenter } from "@/components/screens/import-center";
import { ComplaintsExplorer } from "@/components/screens/complaints-explorer";
import { Analytics } from "@/components/screens/analytics";
import { ReportsCenter } from "@/components/screens/reports-center";
import { ClassificationsManager } from "@/components/screens/classifications-manager";
import { ImportLog } from "@/components/screens/import-log";
import { AiAnalysis } from "@/components/screens/ai-analysis";
import { TextRisks } from "@/components/screens/text-risks";
import { Settings } from "@/components/screens/settings";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import type { ScreenId } from "@/app/page";

export function HomeShell({ username }: Readonly<{ username: string }>) {
  const [activeScreen, setActiveScreen] = useState<ScreenId>("dashboard");
  const [resumeBatchId, setResumeBatchId] = useState<string | null>(null);
  // Remount key for screens that read their own filters from the URL on
  // mount (e.g. the complaints explorer) — bumped on every navigation so a
  // drilldown or a Back/Forward that lands back on the same screen with
  // different query params still re-reads them instead of keeping stale state.
  const [locationVersion, setLocationVersion] = useState(0);

  const navigate = useCallback((screen: ScreenId, batchId?: string | null) => {
    setActiveScreen(screen);
    setResumeBatchId(batchId ?? null);
    const params = new URLSearchParams();
    if (screen !== "dashboard") params.set("screen", screen);
    if (batchId) params.set("batchId", batchId);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/?${query}` : "/");
    setLocationVersion((v) => v + 1);
  }, []);

  /**
   * Deliberate cross-screen navigation carrying explicit filters (e.g. a
   * finding's drilldown into the complaints explorer) — a real jump the user
   * chose to make, so it gets its own history entry (Back returns to where
   * they were), unlike the sidebar's plain screen switches above which
   * intentionally keep using replaceState.
   */
  const navigateWithFilters = useCallback((screen: ScreenId, query: Record<string, string>) => {
    setActiveScreen(screen);
    setResumeBatchId(null);
    const params = new URLSearchParams(query);
    if (screen !== "dashboard") params.set("screen", screen);
    window.history.pushState(null, "", `/?${params.toString()}`);
    setLocationVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    const applyFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const screen = params.get("screen") as ScreenId | null;
      const batchId = params.get("batchId");
      if (batchId) {
        setActiveScreen("import");
        setResumeBatchId(batchId);
      } else {
        setActiveScreen(screen ?? "dashboard");
        setResumeBatchId(null);
      }
      setLocationVersion((v) => v + 1);
    };

    void Promise.resolve().then(applyFromUrl);

    window.addEventListener("popstate", applyFromUrl);
    return () => window.removeEventListener("popstate", applyFromUrl);
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      <SidebarProvider>
        <AppSidebar activeScreen={activeScreen} onNavigate={(screen) => navigate(screen)} username={username} />
        <SidebarInset className="flex flex-col min-h-screen">
          <main className="flex-1 p-4 md:p-6 lg:p-8 overflow-x-hidden">
            {activeScreen === "dashboard" && <Dashboard onNavigate={setActiveScreen} />}
            {activeScreen === "import" && <ImportCenter batchId={resumeBatchId} />}
            {activeScreen === "explorer" && <ComplaintsExplorer key={locationVersion} />}
            {activeScreen === "analytics" && (
              <Analytics onNavigateToExplorer={(query) => navigateWithFilters("explorer", query)} />
            )}
            {activeScreen === "text-risks" && <TextRisks />}
            {activeScreen === "reports" && <ReportsCenter />}
            {activeScreen === "classifications" && <ClassificationsManager />}
            {activeScreen === "import-log" && <ImportLog onResume={(batchId) => navigate("import", batchId)} />}
            {activeScreen === "settings" && <Settings />}
            {activeScreen === "ai-analysis" && <AiAnalysis />}
          </main>
          <footer className="border-t bg-card py-4 px-6 mt-auto">
            <div className="flex flex-col md:flex-row items-center justify-between gap-2 text-sm text-muted-foreground">
              <p>نظام إدارة الشكاوى © 2024 - جميع الحقوق محفوظة</p>
              <p className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-soft-pulse" />
                <span>النظام يعمل بشكل طبيعي</span>
              </p>
            </div>
          </footer>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
