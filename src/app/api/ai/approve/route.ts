import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "AI_NOT_CONFIGURED",
      message: "AI approval is outside Phase 2 and requires governed AI workflow configuration.",
    },
    { status: 501 }
  );
}
