"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
  LogOut,
  KeyRound,
  Settings,
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  { id: "text-risks", label: "مراجعة إشارات الخطر", icon: ShieldCheck, description: "إشارات المخاطر المستخرجة من النص", group: "التحليل" },
  { id: "ai-analysis", label: "التحليل الذكي", icon: Sparkles, description: "تحليل بالذكاء الاصطناعي", group: "التحليل" },
  { id: "reports", label: "مركز التقارير", icon: FileText, description: "إنشاء وتصدير التقارير", group: "التقارير" },
  { id: "classifications", label: "إدارة التصنيفات", icon: Tags, description: "التصنيفات والكلمات الدالة", group: "الإدارة" },
  { id: "import-log", label: "سجل الاستيراد", icon: History, description: "تاريخ دفعات الاستيراد", group: "الإدارة" },
  { id: "settings", label: "الإعدادات", icon: Settings, description: "إدارة السجون والحالة التشغيلية", group: "الإدارة" },
];

interface AppSidebarProps {
  activeScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  username: string;
}

export function AppSidebar({ activeScreen, onNavigate, username }: Readonly<AppSidebarProps>) {
  const groups = Array.from(new Set(menuItems.map(m => m.group)));
  const router = useRouter();
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);

  async function logout() {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (response.ok) {
      router.replace("/login");
      return;
    }

    setPasswordError("تعذر تسجيل الخروج، حاول مرة أخرى");
  }

  async function changePassword(formData: FormData) {
    setPasswordLoading(true);
    setPasswordError("");
    setPasswordSuccess("");

    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: formData.get("currentPassword"),
          newPassword: formData.get("newPassword"),
          confirmPassword: formData.get("confirmPassword"),
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setPasswordError(payload?.error?.message ?? "تعذر تغيير كلمة المرور");
        return;
      }

      setPasswordSuccess("تم تغيير كلمة المرور. سجل الدخول مجددًا.");
      setTimeout(() => router.replace("/login"), 600);
    } catch {
      setPasswordError("تعذر الاتصال بالخادم");
    } finally {
      setPasswordLoading(false);
    }
  }

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
        <div className="space-y-3 rounded-lg bg-muted/50 p-3">
          <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
            م
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">مدير النظام</p>
            <p className="text-xs text-muted-foreground truncate">{username}</p>
          </div>
          <Badge variant="secondary" className="text-xs">وضع مفرد</Badge>
          </div>
          <div className="flex gap-2">
            <Dialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen}>
              <DialogTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="flex-1 gap-2">
                  <KeyRound className="h-4 w-4" />
                  كلمة المرور
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>تغيير كلمة المرور</DialogTitle>
                  <DialogDescription>سيتم إنهاء الجلسات بعد نجاح التغيير.</DialogDescription>
                </DialogHeader>
                <form action={changePassword} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="currentPassword">كلمة المرور الحالية</Label>
                    <Input id="currentPassword" name="currentPassword" type="password" required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newPassword">كلمة المرور الجديدة</Label>
                    <Input id="newPassword" name="newPassword" type="password" required minLength={12} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">تأكيد كلمة المرور الجديدة</Label>
                    <Input id="confirmPassword" name="confirmPassword" type="password" required minLength={12} />
                  </div>
                  {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
                  {passwordSuccess && <p className="text-sm text-emerald-600">{passwordSuccess}</p>}
                  <Button type="submit" className="w-full" disabled={passwordLoading}>
                    {passwordLoading ? "جارٍ الحفظ..." : "حفظ كلمة المرور"}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
            <Button type="button" variant="ghost" size="sm" onClick={logout} aria-label="تسجيل الخروج">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
