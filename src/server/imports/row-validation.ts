import { ComplaintStatus, type Category, type Classification } from "@prisma/client";
import type { NormalizedComplaintRow, RowMessage } from "./normalization";

type TaxonomyLookup = {
  categories: Category[];
  classifications: Array<Classification & { category: Category }>;
};

const OPEN_STATUSES = new Set<ComplaintStatus>([
  ComplaintStatus.NEW,
  ComplaintStatus.OPEN,
  ComplaintStatus.IN_PROGRESS,
  ComplaintStatus.AWAITING_RESPONSE,
  ComplaintStatus.RESOLVED,
]);

function normalizeLookup(value?: string): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ar-SA");
}

export function validateNormalizedComplaintRow(
  row: NormalizedComplaintRow,
  lookup: TaxonomyLookup,
  now = new Date()
): RowMessage[] {
  const errors: RowMessage[] = [];

  if (!row.externalId && !row.sourceReference) {
    errors.push({
      field: "externalId",
      code: "MISSING_IDENTITY",
      message: "يجب توفير رقم الشكوى أو الرقم المرجعي",
    });
  }

  if (!row.complaintDate && !row.receivedAt) {
    errors.push({
      field: "complaintDate",
      code: "MISSING_COMPLAINT_DATE",
      message: "يجب توفير تاريخ الشكوى أو تاريخ الورود",
    });
  }

  if (!row.subject && !row.description) {
    errors.push({
      field: "subject",
      code: "MISSING_TEXT",
      message: "يجب توفير الموضوع أو وصف الشكوى",
    });
  }

  const complaintDate = row.complaintDate ?? row.receivedAt;
  if (complaintDate && complaintDate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    errors.push({
      field: "complaintDate",
      code: "COMPLAINT_DATE_IN_FUTURE",
      message: "تاريخ الشكوى مستقبلي بصورة غير مقبولة",
    });
  }

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

  if (row.subject && row.subject.length > 300) {
    errors.push({ field: "subject", code: "SUBJECT_TOO_LONG", message: "الموضوع يتجاوز الطول المسموح" });
  }

  if (row.description && row.description.length > 5_000) {
    errors.push({ field: "description", code: "DESCRIPTION_TOO_LONG", message: "الوصف يتجاوز الطول المسموح" });
  }

  const category = row.category
    ? lookup.categories.find((item) => normalizeLookup(item.nameAr) === normalizeLookup(row.category))
    : null;
  if (row.category && !category) {
    errors.push({ field: "category", code: "CATEGORY_NOT_FOUND", message: "الفئة غير موجودة أو غير فعالة" });
  }

  const classification = row.classification
    ? lookup.classifications.find((item) => normalizeLookup(item.nameAr) === normalizeLookup(row.classification))
    : null;
  if (row.classification && !classification) {
    errors.push({
      field: "classification",
      code: "CLASSIFICATION_NOT_FOUND",
      message: "التصنيف غير موجود أو غير فعال",
    });
  }

  if (category && classification && classification.categoryId !== category.id) {
    errors.push({
      field: "classification",
      code: "CLASSIFICATION_CATEGORY_MISMATCH",
      message: "التصنيف لا يتبع الفئة المحددة",
    });
  }

  return errors;
}
