import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "AI executive summaries are not enabled in the foundation phase.",
      code: "AI_NOT_CONFIGURED",
    },
    { status: 501 }
  );
}
