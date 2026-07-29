import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { mapAuthError } from "@/server/auth/auth-guard";
import { toImportConfirmationErrorResponse } from "@/server/imports/import-confirmation-service";

type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
  };
};

type ImportRouteErrorOptions = {
  validation?: ErrorEnvelope;
  fallback: ErrorEnvelope;
};

export function toImportRouteErrorResponse(
  error: unknown,
  options: ImportRouteErrorOptions
): NextResponse {
  const authResponse = mapAuthError(error);
  if (authResponse) {
    return authResponse;
  }

  if (options.validation && error instanceof ZodError) {
    return NextResponse.json(options.validation, { status: 422 });
  }

  const importResponse = toImportConfirmationErrorResponse(error);
  if (importResponse) {
    return NextResponse.json(importResponse.body, { status: importResponse.status });
  }

  return NextResponse.json(options.fallback, { status: 500 });
}
