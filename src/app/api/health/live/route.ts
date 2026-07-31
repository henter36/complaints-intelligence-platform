import { NextResponse } from "next/server";

// Liveness probe — just confirms the process is up.
// Never calls the database or external services.
export async function GET() {
  return NextResponse.json({ status: "live" });
}
