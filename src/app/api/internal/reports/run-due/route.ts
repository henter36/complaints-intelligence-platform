import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runDueSchedule } from "@/server/reports/report-schedule-service";

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    // Compare against a same-length dummy so timing does not leak the
    // expected secret's length either.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export async function POST(req: NextRequest) {
  const configuredSecret = env.internalSchedulerSecret;
  if (!configuredSecret) {
    return NextResponse.json(
      { error: { code: "SCHEDULER_NOT_CONFIGURED", message: "لم يتم تهيئة سر المجدول الداخلي" } },
      { status: 503 }
    );
  }

  const providedSecret = req.headers.get("x-scheduler-secret") ?? "";
  if (!providedSecret || !constantTimeEquals(providedSecret, configuredSecret)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "سر المجدول غير صحيح" } },
      { status: 401 }
    );
  }

  try {
    const result = await runDueSchedule(new Date());
    return NextResponse.json({ result });
  } catch (error) {
    console.error("Internal reports run-due error:", error);
    return NextResponse.json(
      { error: { code: "SCHEDULER_RUN_FAILED", message: "تعذر تنفيذ الجدولة" } },
      { status: 500 }
    );
  }
}
