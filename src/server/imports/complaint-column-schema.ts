import { ImportValidationError } from "./import-errors";

export const COMPLAINT_IMPORT_FIELDS = [
  "externalId",
  "sourceReference",
  "complaintDate",
  "receivedAt",
  "dueDate",
  "closedAt",
  "status",
  "subject",
  "description",
  "complainantName",
  "complainantIdentifier",
  "complainantPhone",
  "region",
  "facility",
  "department",
  "category",
  "classification",
  "priority",
  "channel",
  "resolution",
] as const;

export type ComplaintImportField = (typeof COMPLAINT_IMPORT_FIELDS)[number];
export type ColumnMapping = Record<string, ComplaintImportField>;

const FIELD_LABELS: Record<ComplaintImportField, string> = {
  externalId: "رقم الشكوى",
  sourceReference: "الرقم المرجعي",
  complaintDate: "تاريخ الشكوى",
  receivedAt: "تاريخ الورود",
  dueDate: "تاريخ الاستحقاق",
  closedAt: "تاريخ الإغلاق",
  status: "الحالة",
  subject: "الموضوع",
  description: "وصف الشكوى",
  complainantName: "اسم مقدم الشكوى",
  complainantIdentifier: "معرف مقدم الشكوى",
  complainantPhone: "هاتف مقدم الشكوى",
  region: "المنطقة",
  facility: "المنشأة",
  department: "الإدارة",
  category: "الفئة",
  classification: "التصنيف",
  priority: "الأولوية",
  channel: "القناة",
  resolution: "الإجراء أو الحل",
};

const SYNONYMS: Record<ComplaintImportField, string[]> = {
  externalId: ["رقم الشكوى", "معرف الشكوى", "complaint id", "external id"],
  sourceReference: ["الرقم المرجعي", "رقم المرجع", "مصدر الشكوى", "source reference"],
  complaintDate: ["تاريخ الشكوى", "complaint date"],
  receivedAt: ["تاريخ الورود", "تاريخ الاستلام", "received at", "received date"],
  dueDate: ["تاريخ الاستحقاق", "المهلة", "due date"],
  closedAt: ["تاريخ الإغلاق", "closure date", "closed at"],
  status: ["الحالة", "status"],
  subject: ["الموضوع", "عنوان الشكوى", "subject"],
  description: ["وصف الشكوى", "الوصف", "description"],
  complainantName: ["اسم مقدم الشكوى", "اسم المشتكي", "complainant name"],
  complainantIdentifier: ["معرف مقدم الشكوى", "رقم الهوية", "complainant identifier"],
  complainantPhone: ["هاتف مقدم الشكوى", "رقم الجوال", "رقم الهاتف", "complainant phone"],
  region: ["المنطقة", "region"],
  facility: ["الموقع", "المنشأة", "facility"],
  department: ["الإدارة", "department"],
  category: ["الفئة", "category"],
  classification: ["التصنيف", "classification"],
  priority: ["الأولوية", "priority"],
  channel: ["القناة", "channel"],
  resolution: ["الإجراء أو الحل", "الحل", "resolution"],
};

export function normalizeColumnHeader(value: string): string {
  return value
    .trim()
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
}

const SYNONYM_INDEX = new Map<string, ComplaintImportField>();

for (const field of COMPLAINT_IMPORT_FIELDS) {
  SYNONYM_INDEX.set(normalizeColumnHeader(field), field);
  SYNONYM_INDEX.set(normalizeColumnHeader(FIELD_LABELS[field]), field);
  for (const synonym of SYNONYMS[field]) {
    SYNONYM_INDEX.set(normalizeColumnHeader(synonym), field);
  }
}

export function matchComplaintColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const usedFields = new Map<ComplaintImportField, string>();

  for (const header of headers) {
    const normalized = normalizeColumnHeader(header);
    if (!normalized) continue;

    const field = SYNONYM_INDEX.get(normalized);
    if (!field) continue;

    const previousHeader = usedFields.get(field);
    if (previousHeader) {
      throw new ImportValidationError(
        "DUPLICATE_IMPORT_COLUMN",
        `تكرر ربط الحقل ${FIELD_LABELS[field]} بين ${previousHeader} و${header}`,
        422
      );
    }

    mapping[header] = field;
    usedFields.set(field, header);
  }

  return mapping;
}

export function validateColumnMapping(mapping: ColumnMapping): void {
  const fields = new Set(Object.values(mapping));
  const hasIdentity = fields.has("externalId") || fields.has("sourceReference");
  const hasDate = fields.has("complaintDate") || fields.has("receivedAt");
  const hasText = fields.has("subject") || fields.has("description");

  if (!hasIdentity || !hasDate || !hasText) {
    throw new ImportValidationError(
      "IMPORT_REQUIRED_COLUMNS_MISSING",
      "يجب ربط معرف أو رقم مرجعي، وتاريخ، وموضوع أو وصف على الأقل",
      422
    );
  }
}

export function toFieldLabels(): Record<ComplaintImportField, string> {
  return FIELD_LABELS;
}
