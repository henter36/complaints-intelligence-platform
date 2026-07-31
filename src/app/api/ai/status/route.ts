import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { env } from "@/lib/env";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    return NextResponse.json({
      enabled: env.aiEnabled,
      provider: env.aiEnabled ? env.aiProvider : null,
      model: env.aiEnabled ? env.aiModel : null,
      maxInputComplaints: env.aiMaxInputComplaints,
      maxInputChars: env.aiMaxInputChars,
      dailyRunLimit: env.aiDailyRunLimit,
      retentionDays: env.aiRetentionDays,
    });
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
