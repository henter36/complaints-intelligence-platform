import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE_NAME } from "@/server/auth/auth-config";
import { changeAdminPassword, isAdminCredentialError } from "@/server/auth/admin-service";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(12).max(512),
  confirmPassword: z.string().min(12).max(512),
});

export async function POST(request: NextRequest) {
  try {
    await requireAdminApiSession(request);
    const input = changePasswordSchema.parse(await request.json());
    await changeAdminPassword(input);

    const response = NextResponse.json({ ok: true });
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: { code: "INVALID_PASSWORD_INPUT", message: "بيانات كلمة المرور غير صالحة" } },
        { status: 400 }
      );
    }

    if (isAdminCredentialError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }

    console.error("Change password failed:", error);
    return NextResponse.json(
      { error: { code: "PASSWORD_CHANGE_FAILED", message: "تعذر تغيير كلمة المرور" } },
      { status: 500 }
    );
  }
}
