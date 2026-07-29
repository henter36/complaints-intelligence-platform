export class ImportValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 422,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ImportValidationError";
  }
}

export function toImportErrorResponse(error: unknown): {
  body: { error: { code: string; message: string } & Record<string, unknown> };
  status: number;
} | null {
  if (!(error instanceof ImportValidationError)) {
    return null;
  }

  return {
    status: error.status,
    body: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ?? {}),
      },
    },
  };
}
