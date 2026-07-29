import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { LoginForm } from "@/app/login/login-form";
import { getCurrentAdminSessionFromCookies } from "@/server/auth/session-service";

export default async function LoginPage() {
  const session = await getCurrentAdminSessionFromCookies();

  if (session) {
    redirect("/");
  }

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-md items-center">
        <section className="w-full rounded-lg border bg-card p-6 shadow-sm">
          <div className="mb-8 space-y-3 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="h-7 w-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">تسجيل الدخول</h1>
              <p className="mt-1 text-sm text-muted-foreground">وضع المسؤول المفرد لمنصة ذكاء الشكاوى</p>
            </div>
          </div>
          <LoginForm />
        </section>
      </div>
    </main>
  );
}
