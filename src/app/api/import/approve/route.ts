import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

export async function POST(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    return NextResponse.json(
      {
        error: "NOT_IMPLEMENTED",
        message: "Import confirmation requires a future Excel import engine and is not implemented.",
      },
      { status: 501 }
    );
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json({ error: "Import approve failed" }, { status: 500 });
  }
}
