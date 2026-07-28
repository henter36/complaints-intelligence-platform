"use client";

import {
  LayoutDashboard,
  Upload,
  Search,
  BarChart3,
  FileText,
  Tags,
  History,
  Sparkles,
  ShieldCheck,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import type { ScreenId } from "@/app/page";

const menuItems: {
  id: ScreenId;
  label: string;
  icon: any;
  description: string;
  group: string;
}[] = [
  { id: "dashboard", label: "الشاشة الرئيسية", icon: LayoutDashboard, description: "المؤشرات التنفيذية", group: "الرئيسية" },
  { id: "import", label: "مركز الاستيراد", icon: Upload, description: "رفع ومعالجة الملفات", group: "البيانات" },
  { id: "explorer", label: "مستكشف الشكاوى", icon: Search, description: "البحث والتصفية", group: "البيانات" },
  { id: "analytics", label: "التحليلات", icon: BarChart3, description: "الاتجاهات والمقارنات", group: "التحليل" },
  { id: "ai-analysis", label: "التحليل الذكي", icon: Sparkles, description: "تحليل بالذكاء الاصطناعي", group: "التحليل" },
  { id: "reports", label: "مركز التقارير", icon: FileText, description: "إنشاء وتصدير التقارير", group: "التقارير" },
  { id: "classifications", label: "إدارة التصنيفات", icon: Tags, description: "التصنيفات والكلمات الدالة", group: "الإدارة" },
  { id: "import-log", label: "سجل الاستيراد", icon: History, description: "تاريخ دفعات الاستيراد", group: "الإدارة" },
];

interface AppSidebarProps {
  activeScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
}

export function AppSidebar({ activeScreen, onNavigate }: AppSidebarProps) {
  const groups = Array.from(new Set(menuItems.map(m => m.group)));

  return (
    <Sidebar side="right" className="border-l">
      <SidebarHeader className="border-b p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl gradient-primary text-primary-foreground shadow-md">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-base font-bold leading-tight">نظام الشكاوى</h2>
            <p className="text-xs text-muted-foreground">لوحة المؤشرات الذكية</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {groups.map(group => (
          <SidebarGroup key={group}>
            <SidebarGroupLabel>{group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {menuItems
                  .filter(m => m.group === group)
                  .map(item => {
                    const isActive = activeScreen === item.id;
                    const Icon = item.icon;
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => onNavigate(item.id)}
                          tooltip={item.description}
                          className="gap-3"
                        >
                          <Icon className={`h-5 w-5 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{item.label}</span>
                            <span className="text-xs text-muted-foreground">{item.description}</span>
                          </div>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t p-4">
        <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
            م
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">مدير النظام</p>
            <p className="text-xs text-muted-foreground truncate">admin@shakawi.gov.sa</p>
          </div>
          <Badge variant="secondary" className="text-xs">صلاحية كاملة</Badge>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
