import { ImportValidationError } from "./import-errors";
import { normalizeArabic } from "./arabic-normalize";

export const COMPLAINT_IMPORT_FIELDS = [
  "externalId",
  "sourceReference",
  "complaintDate",
  "receivedAt",
  "dueDate",
  "closedAt",
  "status",
  "sourceDetail",
  "sourceActionStatus",
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

export type ColumnMappingStatus =
  | "AUTO_MAPPED"
  | "MANUALLY_MAPPED"
  | "UNMAPPED_PRESERVED"
  | "CONFLICT"
  | "MISSING_REQUIRED";

export type ColumnMappingEntry = {
  header: string;
  normalizedHeader: string;
  field: ComplaintImportField | null;
  status: ColumnMappingStatus;
  suggestedField?: ComplaintImportField;
};

export type ColumnMappingAnalysis = {
  entries: ColumnMappingEntry[];
  autoMappedCount: number;
  manuallyMappedCount: number;
  unmappedPreservedCount: number;
  conflictCount: number;
  missingRequiredFields: string[];
  summary: string;
  unmappedColumns: string[];
  conflicts: Array<{ header: string; field: ComplaintImportField; conflictingHeader: string }>;
};

const COMPLAINT_IMPORT_FIELD_SET = new Set<ComplaintImportField>(COMPLAINT_IMPORT_FIELDS);
const DANGEROUS_MAPPING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const FIELD_LABELS: Record<ComplaintImportField, string> = {
  externalId: "رقم الشكوى",
  sourceReference: "الرقم المرجعي",
  complaintDate: "تاريخ الشكوى",
  receivedAt: "تاريخ الورود",
  dueDate: "تاريخ الاستحقاق",
  closedAt: "تاريخ الإغلاق",
  status: "الحالة",
  sourceDetail: "تفصيل",
  sourceActionStatus: "حالة الإجراء",
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

/** Prefer primary action text over descriptive action text when both headers are present. */
const RESOLUTION_HEADER_PRIORITY = [
  "الاجراء المتخذ",
  "الاجراء او الحل",
  "الحل",
  "resolution",
  "وصف الاجراء",
];

const SYNONYMS: Record<ComplaintImportField, string[]> = {
  externalId: [
    "رقم الشكوى",
    "معرف الشكوى",
    "رقم البلاغ",
    "complaint id",
    "external id",
  ],
  sourceReference: [
    "المُعرف",
    "المعرف",
    "الرقم المرجعي",
    "رقم المرجع",
    "رقم المعاملة",
    "source reference",
  ],
  complaintDate: [
    "تاريخ الإنشاء",
    "تاريخ انشاء الشكوى",
    "تاريخ الشكوى",
    "تاريخ تقديم الشكوى",
    "complaint date",
    "created date",
  ],
  receivedAt: [
    "تاريخ التسجيل",
    "تاريخ الورود",
    "تاريخ الاستلام",
    "تاريخ القيد",
    "تاريخ استقبال الشكوى",
    "received at",
    "received date",
  ],
  dueDate: ["تاريخ الاستحقاق", "المهلة", "due date"],
  closedAt: ["تاريخ الإغلاق", "closure date", "closed at"],
  status: ["الحالة", "حالة الشكوى", "status"],
  sourceDetail: ["تفصيل", "source detail"],
  sourceActionStatus: ["حالة الاجراء", "حالة الإجراء", "action status"],
  subject: ["الموضوع", "عنوان الشكوى", "subject"],
  description: [
    "الوصف",
    "وصف الشكوى",
    "تفاصيل الشكوى",
    "نص الشكوى",
    "محتوى الشكوى",
    "description",
  ],
  complainantName: ["اسم مقدم الشكوى", "اسم المشتكي", "complainant name"],
  complainantIdentifier: [
    "هوية السجين",
    "هوية النزيل",
    "رقم هوية السجين",
    "رقم هوية النزيل",
    "رقم الهوية",
    "معرف مقدم الشكوى",
    "complainant identifier",
  ],
  complainantPhone: ["هاتف مقدم الشكوى", "رقم الجوال", "رقم الهاتف", "complainant phone"],
  region: ["المنطقة", "اسم المنطقة", "region"],
  facility: ["السجن", "المنشأة", "الموقع", "اسم السجن", "facility"],
  department: ["القسم", "الإدارة", "الادارة", "department"],
  category: ["الفئة", "category"],
  classification: ["تصنيف", "التصنيف", "نوع الشكوى", "classification"],
  priority: ["الأولوية", "priority"],
  channel: ["المصدر", "مصدر الشكوى", "القناة", "channel", "source"],
  resolution: [
    "الإجراء المتخذ",
    "الاجراء المتخذ",
    "وصف الإجراء",
    "وصف الاجراء",
    "الإجراء أو الحل",
    "الحل",
    "resolution",
  ],
};

export function normalizeColumnHeader(value: string): string {
  return normalizeArabic(value)
    .replaceAll(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
}

const SYNONYM_INDEX = new Map<string, ComplaintImportField>();

for (const field of COMPLAINT_IMPORT_FIELDS) {
  SYNONYM_INDEX.set(normalizeColumnHeader(field), field);
  SYNONYM_INDEX.set(normalizeColumnHeader(FIELD_LABELS[field]), field);
  for (const synonym of SYNONYMS[field]) {
    const key = normalizeColumnHeader(synonym);
    const existing = SYNONYM_INDEX.get(key);
    if (existing && existing !== field) {
      throw new Error(`Synonym conflict: "${synonym}" maps to both ${existing} and ${field}`);
    }
    SYNONYM_INDEX.set(key, field);
  }
}

function resolutionPriority(header: string): number {
  const normalized = normalizeColumnHeader(header);
  const index = RESOLUTION_HEADER_PRIORITY.findIndex((item) => normalizeColumnHeader(item) === normalized);
  return index === -1 ? RESOLUTION_HEADER_PRIORITY.length : index;
}

function preferHeaderForField(
  field: ComplaintImportField,
  previousHeader: string,
  nextHeader: string
): string {
  if (field !== "resolution") {
    return previousHeader;
  }

  return resolutionPriority(nextHeader) < resolutionPriority(previousHeader)
    ? nextHeader
    : previousHeader;
}

export function matchComplaintColumns(headers: string[]): {
  mapping: ColumnMapping;
  conflicts: Array<{ header: string; field: ComplaintImportField; conflictingHeader: string }>;
} {
  const mapping = Object.create(null) as ColumnMapping;
  const usedFields = new Map<ComplaintImportField, string>();
  const conflicts: Array<{ header: string; field: ComplaintImportField; conflictingHeader: string }> = [];

  for (const header of headers) {
    const normalized = normalizeColumnHeader(header);
    if (!normalized) continue;

    const field = SYNONYM_INDEX.get(normalized);
    if (!field) continue;

    const previousHeader = usedFields.get(field);
    if (previousHeader) {
      const preferred = preferHeaderForField(field, previousHeader, header);
      const discarded = preferred === previousHeader ? header : previousHeader;
      conflicts.push({
        header: discarded,
        field,
        conflictingHeader: preferred,
      });

      if (preferred === header) {
        delete mapping[previousHeader];
        mapping[header] = field;
        usedFields.set(field, header);
      }
      continue;
    }

    mapping[header] = field;
    usedFields.set(field, header);
  }

  return { mapping, conflicts };
}

function classifyHeaderMappingEntry(input: {
  trimmed: string;
  header: string;
  mapping: ColumnMapping;
  conflictHeaders: Set<string>;
  manuallyMapped?: boolean;
}): ColumnMappingEntry {
  const normalizedHeader = normalizeColumnHeader(input.trimmed);
  const field = input.mapping[input.trimmed] ?? input.mapping[input.header] ?? null;
  const suggested = SYNONYM_INDEX.get(normalizedHeader);

  if (input.conflictHeaders.has(input.trimmed) || input.conflictHeaders.has(input.header)) {
    return {
      header: input.trimmed,
      normalizedHeader,
      field: null,
      status: "CONFLICT",
      suggestedField: suggested,
    };
  }

  if (field) {
    return {
      header: input.trimmed,
      normalizedHeader,
      field,
      status: input.manuallyMapped ? "MANUALLY_MAPPED" : "AUTO_MAPPED",
      suggestedField: suggested,
    };
  }

  return {
    header: input.trimmed,
    normalizedHeader,
    field: null,
    status: "UNMAPPED_PRESERVED",
    suggestedField: suggested,
  };
}

function collectMissingRequiredFields(mappedFields: Set<ComplaintImportField>): string[] {
  const missingRequiredFields: string[] = [];

  if (!mappedFields.has("externalId") && !mappedFields.has("sourceReference")) {
    missingRequiredFields.push("externalId|sourceReference");
  }
  if (!mappedFields.has("complaintDate") && !mappedFields.has("receivedAt")) {
    missingRequiredFields.push("complaintDate|receivedAt");
  }
  if (!mappedFields.has("subject") && !mappedFields.has("description")) {
    missingRequiredFields.push("subject|description");
  }

  return missingRequiredFields;
}

function countEntriesByStatus(entries: ColumnMappingEntry[], status: ColumnMappingStatus): number {
  return entries.filter((entry) => entry.status === status).length;
}

export function analyzeColumnMapping(
  headers: string[],
  mapping: ColumnMapping,
  options?: {
    conflicts?: Array<{ header: string; field: ComplaintImportField; conflictingHeader: string }>;
    manuallyMapped?: boolean;
  }
): ColumnMappingAnalysis {
  const conflicts = options?.conflicts ?? [];
  const conflictHeaders = new Set(conflicts.map((item) => item.header));
  const mappedHeaders = new Set(Object.keys(mapping));
  const mappedFields = new Set(Object.values(mapping));

  const entries: ColumnMappingEntry[] = [];
  for (const header of headers) {
    const trimmed = header.trim();
    if (!trimmed) continue;

    entries.push(
      classifyHeaderMappingEntry({
        trimmed,
        header,
        mapping,
        conflictHeaders,
        manuallyMapped: options?.manuallyMapped,
      })
    );
  }

  const missingRequiredFields = collectMissingRequiredFields(mappedFields);
  for (const key of missingRequiredFields) {
    entries.push({
      header: key,
      normalizedHeader: key,
      field: null,
      status: "MISSING_REQUIRED",
    });
  }

  const autoMappedCount = countEntriesByStatus(entries, "AUTO_MAPPED");
  const manuallyMappedCount = countEntriesByStatus(entries, "MANUALLY_MAPPED");
  const unmappedPreservedCount = countEntriesByStatus(entries, "UNMAPPED_PRESERVED");
  const conflictCount = countEntriesByStatus(entries, "CONFLICT");
  const mappedCount = autoMappedCount + manuallyMappedCount;

  return {
    entries,
    autoMappedCount,
    manuallyMappedCount,
    unmappedPreservedCount,
    conflictCount,
    missingRequiredFields,
    summary: `تم التعرف تلقائيًا على ${mappedCount} عمودًا، واحتفظ النظام بـ${unmappedPreservedCount} أعمدة إضافية ضمن البيانات الأصلية.`,
    unmappedColumns: headers
      .map((header) => header.trim())
      .filter(Boolean)
      .filter((header) => !mappedHeaders.has(header)),
    conflicts,
  };
}

export function isComplaintImportField(value: unknown): value is ComplaintImportField {
  return typeof value === "string" && COMPLAINT_IMPORT_FIELD_SET.has(value as ComplaintImportField);
}

function assertSafeMappingHeader(header: string): void {
  if (DANGEROUS_MAPPING_KEYS.has(header)) {
    throw new ImportValidationError(
      "IMPORT_INVALID_COLUMN_MAPPING",
      `عنوان العمود غير مسموح: ${header}`,
      422,
      { header }
    );
  }
}

export function parseColumnMapping(value: unknown): ColumnMapping | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ImportValidationError(
      "IMPORT_INVALID_COLUMN_MAPPING",
      "مطابقة الأعمدة غير صالحة",
      422
    );
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return undefined;
  }

  const mapping = Object.create(null) as ColumnMapping;
  let emptyHeaderCount = 0;

  for (const [header, field] of entries) {
    const normalizedHeader = header.trim();

    if (!normalizedHeader) {
      emptyHeaderCount += 1;
      continue;
    }

    assertSafeMappingHeader(normalizedHeader);

    if (Object.hasOwn(mapping, normalizedHeader)) {
      throw new ImportValidationError(
        "IMPORT_INVALID_COLUMN_MAPPING",
        `تكرر عنوان العمود بعد التنظيف: ${normalizedHeader}`,
        422,
        { header: normalizedHeader }
      );
    }

    if (!isComplaintImportField(field)) {
      throw new ImportValidationError(
        "IMPORT_INVALID_COLUMN_MAPPING",
        `حقل الربط غير مدعوم للعمود: ${normalizedHeader}`,
        422,
        {
          header: normalizedHeader,
          field,
        }
      );
    }

    mapping[normalizedHeader] = field;
  }

  const hasMapping = Object.keys(mapping).length > 0;
  if (!hasMapping && emptyHeaderCount > 0) {
    return undefined;
  }

  if (hasMapping && emptyHeaderCount > 0) {
    throw new ImportValidationError(
      "IMPORT_INVALID_COLUMN_MAPPING",
      "يحتوي ربط الأعمدة على عنوان عمود فارغ",
      422
    );
  }

  return hasMapping ? mapping : undefined;
}

export function validateColumnMapping(mapping: ColumnMapping, workbookHeaders?: readonly string[]): void {
  const usedFields = new Map<ComplaintImportField, string>();
  const workbookHeaderSet = workbookHeaders
    ? new Set(workbookHeaders.map((header) => header.trim()))
    : null;

  for (const [header, field] of Object.entries(mapping)) {
    const normalizedHeader = header.trim();

    if (!normalizedHeader) {
      throw new ImportValidationError(
        "IMPORT_INVALID_COLUMN_MAPPING",
        "يحتوي ربط الأعمدة على عنوان عمود فارغ",
        422
      );
    }

    assertSafeMappingHeader(normalizedHeader);

    if (!isComplaintImportField(field)) {
      throw new ImportValidationError(
        "IMPORT_INVALID_COLUMN_MAPPING",
        `حقل الربط غير مدعوم للعمود: ${normalizedHeader}`,
        422,
        { header: normalizedHeader, field }
      );
    }

    if (workbookHeaderSet && !workbookHeaderSet.has(normalizedHeader)) {
      throw new ImportValidationError(
        "IMPORT_INVALID_COLUMN_MAPPING",
        `يشير ربط الأعمدة إلى عمود غير موجود: ${normalizedHeader}`,
        422,
        { header: normalizedHeader }
      );
    }

    const previousHeader = usedFields.get(field);
    if (previousHeader) {
      throw new ImportValidationError(
        "DUPLICATE_IMPORT_COLUMN",
        `تكرر ربط الحقل ${FIELD_LABELS[field]} بين ${previousHeader} و${header}`,
        422
      );
    }

    usedFields.set(field, normalizedHeader);
  }

  const fields = new Set(usedFields.keys());
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

export function lookupFieldForHeader(header: string): ComplaintImportField | undefined {
  return SYNONYM_INDEX.get(normalizeColumnHeader(header));
}
