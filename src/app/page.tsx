import { redirect } from "next/navigation";
import { HomeShell } from "@/components/layout/home-shell";
import { getCurrentAdminSessionFromCookies } from "@/server/auth/session-service";

export type ScreenId =
  | "dashboard"
  | "import"
  | "explorer"
  | "analytics"
  | "reports"
  | "classifications"
  | "import-log"
  | "ai-analysis";

export default async function Home() {
  const session = await getCurrentAdminSessionFromCookies();

  if (!session) {
    redirect("/login");
  }

  return <HomeShell username={session.username} />;
}
