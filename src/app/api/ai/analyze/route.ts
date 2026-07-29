import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "AI analysis is not enabled in the foundation phase.",
      code: "AI_NOT_CONFIGURED",
    },
    { status: 501 }
  );
}
