import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: "نظام إدارة الشكاوى | لوحة المؤشرات الذكية",
  description: "نظام متكامل لإدارة وتحليل شكاوى المرافق الصحية مع مؤشرات أداء ذكية وتقارير تحليلية",
  keywords: ["إدارة الشكاوى", "المؤشرات", "التحليلات", "التقارير", "الجودة"],
  authors: [{ name: "نظام الشكاوى" }],
  icons: {
    icon: "/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className="font-sans antialiased bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
