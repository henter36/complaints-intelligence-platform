import { createHash } from "node:crypto";

export interface ComplaintIdentityInput {
  externalId?: string | null;
  sourceReference?: string | null;
  complaintDate?: Date | string | null;
  region?: string | null;
  facility?: string | null;
  department?: string | null;
  subject?: string | null;
}

export class ComplaintIdentityValidationError extends Error {
  readonly code = "COMPLAINT_IDENTITY_VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ComplaintIdentityValidationError";
  }
}

export type ComplaintIdentityMatch =
  | { strategy: "externalId"; value: string }
  | { strategy: "sourceReferenceDate"; value: string; sourceReference: string; complaintDate: string }
  | { strategy: "fingerprint"; value: string };

function normalizeText(value?: string | null): string {
  return (value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
}

function normalizeDate(value?: Date | string | null): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new ComplaintIdentityValidationError("complaintDate must be a valid date");
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildComplaintFingerprint(input: ComplaintIdentityInput): string {
  const parts = [
    normalizeDate(input.complaintDate),
    normalizeText(input.sourceReference),
    normalizeText(input.region),
    normalizeText(input.facility),
    normalizeText(input.department),
    normalizeText(input.subject),
  ];

  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function resolveComplaintIdentity(input: ComplaintIdentityInput): ComplaintIdentityMatch {
  const externalId = normalizeText(input.externalId);
  if (externalId) {
    return { strategy: "externalId", value: externalId };
  }

  const sourceReference = normalizeText(input.sourceReference);
  const complaintDate = normalizeDate(input.complaintDate);
  if (sourceReference && complaintDate) {
    return {
      strategy: "sourceReferenceDate",
      value: `${sourceReference}|${complaintDate}`,
      sourceReference,
      complaintDate,
    };
  }

  return { strategy: "fingerprint", value: buildComplaintFingerprint(input) };
}

export function arePotentialDuplicateIdentities(
  left: ComplaintIdentityInput,
  right: ComplaintIdentityInput
): boolean {
  const leftExternalId = normalizeText(left.externalId);
  const rightExternalId = normalizeText(right.externalId);
  if (leftExternalId || rightExternalId) {
    return Boolean(leftExternalId && rightExternalId && leftExternalId === rightExternalId);
  }

  const leftSource = normalizeText(left.sourceReference);
  const rightSource = normalizeText(right.sourceReference);
  const leftDate = normalizeDate(left.complaintDate);
  const rightDate = normalizeDate(right.complaintDate);
  if (leftSource || rightSource || leftDate || rightDate) {
    return Boolean(leftSource && rightSource && leftDate && rightDate && leftSource === rightSource && leftDate === rightDate);
  }

  return buildComplaintFingerprint(left) === buildComplaintFingerprint(right);
}
