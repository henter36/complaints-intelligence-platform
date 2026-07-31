import { ComplaintStatus, type Category, type Classification } from "@prisma/client";
import { normalizeArabic } from "./arabic-normalize";
import type { NormalizedComplaintRow, RowMessage } from "./normalization";

type TaxonomyLookup = {
  categories: Category[];
  classifications: Array<Classification & { category: Category }>;
};

export type TaxonomyValidationResult = {
  errors: RowMessage[];
  warnings: RowMessage[];
  /** Mutates row by clearing unresolved taxonomy names so confirm does not create them. */
  apply: (row: NormalizedComplaintRow) => void;
};

const OPEN_STATUSES = new Set<ComplaintStatus>([
  ComplaintStatus.NEW,
  ComplaintStatus.OPEN,
  ComplaintStatus.IN_PROGRESS,
  ComplaintStatus.AWAITING_RESPONSE,
  ComplaintStatus.RESOLVED,
]);

function normalizeLookup(value?: string): string {
  return normalizeArabic(value ?? "")
    .replaceAll(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
}

function validateRequiredFields(row: NormalizedComplaintRow): RowMessage[] {
  const errors: RowMessage[] = [];

  if (!row.externalId?.trim() && !row.sourceReference?.trim()) {
    errors.push({
      field: "externalId",
      code: "MISSING_IDENTITY",
      message: "رقم الشكوى أو الرقم المرجعي غير موجود.",
    });
  }

  if (!row.complaintDate && !row.receivedAt) {
    errors.push({
      field: "complaintDate",
      code: "MISSING_COMPLAINT_DATE",
      message: "يجب توفير تاريخ الشكوى أو تاريخ الورود",
    });
  }

  if (!row.subject?.trim() && !row.description?.trim()) {
    errors.push({
      field: "description",
      code: "MISSING_TEXT",
      message: "الوصف غير موجود.",
    });
  }

  return errors;
}

function validateDates(row: NormalizedComplaintRow, now: Date): RowMessage[] {
  const errors: RowMessage[] = [];
  const complaintDate = row.complaintDate ?? row.receivedAt;
  if (complaintDate && complaintDate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    errors.push({
      field: "complaintDate",
      code: "COMPLAINT_DATE_IN_FUTURE",
      message: "تاريخ الشكوى مستقبلي بصورة غير مقبولة",
    });
  }

  return errors;
}

function validateLifecycleConsistency(row: NormalizedComplaintRow): RowMessage[] {
  const errors: RowMessage[] = [];

  if (row.closedAt && OPEN_STATUSES.has(row.status ?? ComplaintStatus.NEW)) {
    errors.push({
      field: "closedAt",
      code: "CLOSED_AT_FOR_OPEN_STATUS",
      message: "لا يمكن وضع تاريخ إغلاق لشكوى غير مغلقة",
    });
  }

  if ((row.status === ComplaintStatus.CLOSED || row.status === ComplaintStatus.CANCELLED) && !row.closedAt) {
    errors.push({
      field: "closedAt",
      code: "CLOSED_STATUS_REQUIRES_CLOSED_AT",
      message: "الحالة النهائية تتطلب تاريخ إغلاق",
    });
  }

  return errors;
}

function validateFieldLengths(row: NormalizedComplaintRow): RowMessage[] {
  const errors: RowMessage[] = [];

  if (row.subject && row.subject.length > 300) {
    errors.push({ field: "subject", code: "SUBJECT_TOO_LONG", message: "الموضوع يتجاوز الطول المسموح" });
  }

  if (row.description && row.description.length > 5_000) {
    errors.push({ field: "description", code: "DESCRIPTION_TOO_LONG", message: "الوصف يتجاوز الطول المسموح" });
  }

  return errors;
}

function findCategories(row: NormalizedComplaintRow, lookup: TaxonomyLookup): Category[] {
  if (!row.category) return [];
  const needle = normalizeLookup(row.category);
  return lookup.categories.filter((item) => normalizeLookup(item.nameAr) === needle);
}

function findClassifications(
  row: NormalizedComplaintRow,
  lookup: TaxonomyLookup
): Array<Classification & { category: Category }> {
  if (!row.classification) return [];
  const needle = normalizeLookup(row.classification);
  return lookup.classifications.filter((item) => normalizeLookup(item.nameAr) === needle);
}

function validateTaxonomy(row: NormalizedComplaintRow, lookup: TaxonomyLookup): TaxonomyValidationResult {
  const errors: RowMessage[] = [];
  const warnings: RowMessage[] = [];
  let clearCategory = false;
  let clearClassification = false;

  const categories = findCategories(row, lookup);
  const classifications = findClassifications(row, lookup);
  const categoryPresent = Boolean(row.category?.trim());
  const classificationPresent = Boolean(row.classification?.trim());

  if (categoryPresent && categories.length === 0) {
    warnings.push({
      field: "category",
      code: "CATEGORY_NOT_FOUND",
      message: "الفئة غير موجودة أو غير فعالة، وتم الاحتفاظ بالقيمة ضمن البيانات الأصلية.",
    });
    clearCategory = true;
  } else if (categories.length > 1) {
    warnings.push({
      field: "category",
      code: "CATEGORY_AMBIGUOUS",
      message: "وجد أكثر من فئة مطابقة للاسم المصدر، وتم الاحتفاظ بالقيمة ضمن البيانات الأصلية.",
    });
    clearCategory = true;
  }

  if (classificationPresent && classifications.length === 0) {
    warnings.push({
      field: "classification",
      code: "CLASSIFICATION_NOT_FOUND",
      message: "التصنيف غير موجود أو غير فعال، وتم الاحتفاظ بالقيمة ضمن البيانات الأصلية.",
    });
    clearClassification = true;
  } else if (classifications.length > 1) {
    warnings.push({
      field: "classification",
      code: "CLASSIFICATION_AMBIGUOUS",
      message: "وجد أكثر من تصنيف مطابق للاسم المصدر، وتم الاحتفاظ بالقيمة ضمن البيانات الأصلية.",
    });
    clearClassification = true;
  }

  const categoryUnresolved = categoryPresent && (clearCategory || categories.length !== 1);
  const category = !clearCategory && categories.length === 1 ? categories[0] : null;
  const classification = !clearClassification && classifications.length === 1 ? classifications[0] : null;

  // When a source category exists but is unresolved, do not adopt a lone classification
  // (avoids silently attaching a different parent category).
  if (categoryUnresolved && classificationPresent && !clearClassification) {
    warnings.push({
      field: "classification",
      code: "CLASSIFICATION_PARENT_UNRESOLVED",
      message: "تعذر اعتماد التصنيف لأن الفئة المصدرية غير محسومة، وتم الاحتفاظ بالقيمة ضمن البيانات الأصلية.",
    });
    clearClassification = true;
  }

  if (category && classification && classification.categoryId !== category.id) {
    errors.push({
      field: "classification",
      code: "CLASSIFICATION_CATEGORY_MISMATCH",
      message: "التصنيف لا يتبع الفئة المحددة",
    });
    clearClassification = true;
  }

  return {
    errors,
    warnings,
    apply(target) {
      if (clearCategory) delete target.category;
      if (clearClassification) delete target.classification;
    },
  };
}

export function validateNormalizedComplaintRow(
  row: NormalizedComplaintRow,
  lookup: TaxonomyLookup,
  now = new Date()
): { errors: RowMessage[]; warnings: RowMessage[] } {
  const taxonomy = validateTaxonomy(row, lookup);
  taxonomy.apply(row);

  return {
    errors: [
      ...validateRequiredFields(row),
      ...validateDates(row, now),
      ...validateLifecycleConsistency(row),
      ...validateFieldLengths(row),
      ...taxonomy.errors,
    ],
    warnings: taxonomy.warnings,
  };
}
