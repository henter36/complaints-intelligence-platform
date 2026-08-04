import { z } from "zod";
import { NextResponse } from "next/server";
import { mapAuthError } from "@/server/auth/auth-guard";
import { toClassificationManagementErrorResponse } from "@/server/classifications/classification-management-service";

export type ClassificationRouteOperation =
  | "CATEGORY_CREATE"
  | "CATEGORY_UPDATE"
  | "CLASSIFICATION_CREATE"
  | "CLASSIFICATION_UPDATE";

type OperationConfig = {
  invalidPayloadCode: string;
  invalidPayloadMessage: string;
  unexpectedFieldMessage?: string;
  fallbackCode: string;
  fallbackMessage: string;
  logContext: string;
  supportsUnexpectedCategoryField: boolean;
};

const OPERATION_CONFIG: Record<ClassificationRouteOperation, OperationConfig> = {
  CATEGORY_CREATE: {
    invalidPayloadCode: "INVALID_CATEGORY_PAYLOAD",
    invalidPayloadMessage: "بيانات الفئة غير صالحة",
    unexpectedFieldMessage:
      "حقل غير مسموح لطلب الفئة (مثل keywords أو color أو parentId)",
    fallbackCode: "CATEGORY_CREATE_FAILED",
    fallbackMessage: "تعذر إنشاء الفئة",
    logContext: "Create category error",
    supportsUnexpectedCategoryField: true,
  },
  CATEGORY_UPDATE: {
    invalidPayloadCode: "INVALID_CATEGORY_PAYLOAD",
    invalidPayloadMessage: "بيانات تحديث الفئة غير صالحة",
    unexpectedFieldMessage:
      "حقل غير مسموح عند تحديث الفئة (مثل keywords أو color أو parentId)",
    fallbackCode: "CATEGORY_UPDATE_FAILED",
    fallbackMessage: "تعذر تحديث الفئة",
    logContext: "Update category error",
    supportsUnexpectedCategoryField: true,
  },
  CLASSIFICATION_CREATE: {
    invalidPayloadCode: "INVALID_CLASSIFICATION_PAYLOAD",
    invalidPayloadMessage:
      "بيانات التصنيف غير صالحة. استخدم categoryId لإنشاء تصنيف فقط.",
    fallbackCode: "CLASSIFICATION_CREATE_FAILED",
    fallbackMessage: "تعذر إنشاء التصنيف",
    logContext: "Create classification error",
    supportsUnexpectedCategoryField: false,
  },
  CLASSIFICATION_UPDATE: {
    invalidPayloadCode: "INVALID_CLASSIFICATION_PAYLOAD",
    invalidPayloadMessage: "بيانات تحديث التصنيف غير صالحة",
    fallbackCode: "CLASSIFICATION_UPDATE_FAILED",
    fallbackMessage: "تعذر تحديث التصنيف",
    logContext: "Update classification error",
    supportsUnexpectedCategoryField: false,
  },
};

function errorEnvelope(
  code: string,
  message: string,
  details?: ReturnType<z.ZodError["flatten"]>
) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function handleClassificationManagementRouteError(
  error: unknown,
  operation: ClassificationRouteOperation
): NextResponse {
  const authResponse = mapAuthError(error);
  if (authResponse) return authResponse;

  const management = toClassificationManagementErrorResponse(error);
  if (management) {
    return NextResponse.json(management.body, { status: management.status });
  }

  const config = OPERATION_CONFIG[operation];

  if (error instanceof z.ZodError) {
    const unexpected =
      config.supportsUnexpectedCategoryField
      && error.issues.some((issue) => issue.code === "unrecognized_keys");

    return NextResponse.json(
      errorEnvelope(
        unexpected ? "UNEXPECTED_CATEGORY_FIELD" : config.invalidPayloadCode,
        unexpected
          ? (config.unexpectedFieldMessage ?? config.invalidPayloadMessage)
          : config.invalidPayloadMessage,
        error.flatten()
      ),
      { status: 400 }
    );
  }

  console.error(
    `${config.logContext}:`,
    error instanceof Error ? error.message : "unknown"
  );
  return NextResponse.json(
    errorEnvelope(config.fallbackCode, config.fallbackMessage),
    { status: 500 }
  );
}
