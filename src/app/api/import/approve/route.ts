import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "NOT_IMPLEMENTED",
      message: "Import confirmation requires the Phase 3 Excel import engine and is not implemented in Phase 2.",
    },
    { status: 501 }
  );
}
