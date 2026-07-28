"use client";

import { useState, useEffect } from "react";
import { Dashboard } from "@/components/screens/dashboard";
import { ImportCenter } from "@/components/screens/import-center";
import { ComplaintsExplorer } from "@/components/screens/complaints-explorer";
import { Analytics } from "@/components/screens/analytics";
import { ReportsCenter } from "@/components/screens/reports-center";
import { ClassificationsManager } from "@/components/screens/classifications-manager";
import { ImportLog } from "@/components/screens/import-log";
import { AiAnalysis } from "@/components/screens/ai-analysis";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ScreenId =
  | "dashboard"
  | "import"
  | "explorer"
  | "analytics"
  | "reports"
  | "classifications"
  | "import-log"
  | "ai-analysis";

export default function Home() {
  const [activeScreen, setActiveScreen] = useState<ScreenId>("dashboard");

  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      <SidebarProvider>
        <AppSidebar activeScreen={activeScreen} onNavigate={setActiveScreen} />
        <SidebarInset className="flex flex-col min-h-screen">
          <main className="flex-1 p-4 md:p-6 lg:p-8 overflow-x-hidden">
            {activeScreen === "dashboard" && <Dashboard onNavigate={setActiveScreen} />}
            {activeScreen === "import" && <ImportCenter />}
            {activeScreen === "explorer" && <ComplaintsExplorer />}
            {activeScreen === "analytics" && <Analytics />}
            {activeScreen === "reports" && <ReportsCenter />}
            {activeScreen === "classifications" && <ClassificationsManager />}
            {activeScreen === "import-log" && <ImportLog />}
            {activeScreen === "ai-analysis" && <AiAnalysis />}
          </main>
          <footer className="border-t bg-card py-4 px-6 mt-auto">
            <div className="flex flex-col md:flex-row items-center justify-between gap-2 text-sm text-muted-foreground">
              <p>نظام إدارة الشكاوى © 2024 - جميع الحقوق محفوظة</p>
              <p className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-soft-pulse"></span>
                النظام يعمل بشكل طبيعي
              </p>
            </div>
          </footer>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
