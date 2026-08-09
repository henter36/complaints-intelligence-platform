import {
  ComplaintPriority,
  ComplaintStatus,
  FacilitySyncStatus,
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  PeriodType,
  type PrismaClient,
} from "@prisma/client";
import { pathToFileURL } from "node:url";
import { db as appDb } from "../src/lib/db";
import { createComplaint, updateComplaintStatus } from "../src/server/complaints/complaint-service";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "../src/server/audit/audit-log-service";
import { backfillFacilityRegistry } from "../src/server/facilities/facility-registry-service";

const actor = AUDIT_ACTOR_SINGLE_ADMIN;
const baseDate = new Date("2026-07-15T09:00:00.000Z");

export async function seed(database: PrismaClient = appDb) {
  const db = database;

  console.log("Seeding Phase 2 data model...");

  await db.auditLog.deleteMany();
  await db.importBatchRow.deleteMany();
  await db.complaintStatusHistory.deleteMany();
  await db.complaint.deleteMany();
  await db.facility.deleteMany();
  await db.importBatch.deleteMany();
  await db.reportTemplate.deleteMany();
  await db.classification.deleteMany();
  await db.category.deleteMany();

  const accessCategory = await db.category.create({
    data: {
      nameAr: "الوصول للخدمة",
      nameEn: "Access to care",
      description: "شكاوى تتعلق بالمواعيد والانتظار والوصول للخدمة.",
      displayOrder: 1,
    },
  });
  const qualityCategory = await db.category.create({
    data: {
      nameAr: "جودة الخدمة",
      nameEn: "Service quality",
      description: "شكاوى تتعلق بجودة الخدمة الطبية والمهنية.",
      displayOrder: 2,
    },
  });

  const appointments = await db.classification.create({
    data: {
      categoryId: accessCategory.id,
      nameAr: "المواعيد والانتظار",
      nameEn: "Appointments and waiting",
      color: "#f97316",
      keywords: ["موعد", "انتظار", "تأخير"],
      displayOrder: 1,
    },
  });
  const emergency = await db.classification.create({
    data: {
      categoryId: accessCategory.id,
      nameAr: "الطوارئ",
      nameEn: "Emergency",
      color: "#ef4444",
      keywords: ["طوارئ", "إسعاف"],
      displayOrder: 2,
    },
  });
  const staffBehavior = await db.classification.create({
    data: {
      categoryId: qualityCategory.id,
      nameAr: "السلوك المهني",
      nameEn: "Professional conduct",
      color: "#06b6d4",
      keywords: ["تعامل", "موظف", "سلوك"],
      displayOrder: 1,
    },
  });

  const confirmedBatch = await db.importBatch.create({
    data: {
      fileName: "imports/2026-07-confirmed.csv",
      originalFileName: "شكاوى-يوليو-مؤكدة.csv",
      fileHash: "sha256-confirmed-seed",
      fileSize: 18420,
      mimeType: "text/csv",
      periodType: PeriodType.MONTHLY,
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-07-31T23:59:59.000Z"),
      status: ImportBatchStatus.CONFIRMED,
      totalRows: 4,
      validRows: 3,
      invalidRows: 1,
      newRows: 1,
      updatedRows: 1,
      duplicateRows: 1,
      rejectedRows: 1,
      uploadedAt: new Date("2026-07-16T08:00:00.000Z"),
      validatedAt: new Date("2026-07-16T08:10:00.000Z"),
      confirmedAt: new Date("2026-07-16T08:20:00.000Z"),
      createdBy: actor,
      notes: "Synthetic confirmed import batch.",
    },
  });

  const readyBatch = await db.importBatch.create({
    data: {
      fileName: "imports/2026-07-ready.csv",
      originalFileName: "شكاوى-يوليو-جاهزة.csv",
      fileHash: "sha256-ready-seed",
      fileSize: 12010,
      mimeType: "text/csv",
      periodType: PeriodType.MONTHLY,
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-07-31T23:59:59.000Z"),
      status: ImportBatchStatus.READY_FOR_CONFIRMATION,
      totalRows: 2,
      validRows: 2,
      invalidRows: 0,
      newRows: 1,
      updatedRows: 1,
      duplicateRows: 0,
      rejectedRows: 0,
      uploadedAt: new Date("2026-07-17T08:00:00.000Z"),
      validatedAt: new Date("2026-07-17T08:10:00.000Z"),
      createdBy: actor,
      notes: "Synthetic ready import batch.",
    },
  });

  const openComplaint = await createComplaint(db, {
    externalId: "EXT-2026-0001",
    sourceReference: "SRC-0001",
    complaintDate: new Date("2026-07-10T10:00:00.000Z"),
    receivedAt: new Date("2026-07-10T10:05:00.000Z"),
    dueDate: new Date("2026-07-25T10:00:00.000Z"),
    status: ComplaintStatus.OPEN,
    subject: "تأخر موعد العيادة",
    description: "تأخر موعد العيادة عن الوقت المحدد دون توضيح للمراجع.",
    region: "الرياض",
    facility: "مستشفى تجريبي شمال الرياض",
    department: "إدارة المواعيد",
    categoryId: accessCategory.id,
    classificationId: appointments.id,
    priority: ComplaintPriority.MEDIUM,
    severity: ComplaintPriority.MEDIUM,
    channel: "الهاتف الموحد",
    importBatchId: confirmedBatch.id,
  }, { actor, importBatchId: confirmedBatch.id });

  const closedComplaint = await createComplaint(db, {
    externalId: "EXT-2026-0002",
    sourceReference: "SRC-0002",
    complaintDate: new Date("2026-07-02T11:00:00.000Z"),
    receivedAt: new Date("2026-07-02T11:02:00.000Z"),
    dueDate: new Date("2026-07-12T11:00:00.000Z"),
    closedAt: new Date("2026-07-09T14:00:00.000Z"),
    status: ComplaintStatus.CLOSED,
    subject: "ملاحظة على تعامل موظف",
    description: "ملاحظة صناعية على تجربة المستفيد مع موظف الاستقبال.",
    region: "مكة المكرمة",
    facility: "مركز صحي تجريبي",
    department: "إدارة الاستقبال",
    categoryId: qualityCategory.id,
    classificationId: staffBehavior.id,
    priority: ComplaintPriority.LOW,
    severity: ComplaintPriority.LOW,
    channel: "البريد الإلكتروني",
    resolution: "تمت مراجعة الملاحظة وتحديث إجراءات التواصل.",
    firstActionAt: new Date("2026-07-03T09:00:00.000Z"),
    processingStartedAt: new Date("2026-07-04T09:00:00.000Z"),
    isValidated: true,
    beneficiarySatisfaction: 4,
    importBatchId: confirmedBatch.id,
  }, { actor, importBatchId: confirmedBatch.id });

  const lateComplaint = await createComplaint(db, {
    externalId: "EXT-2026-0003",
    sourceReference: "SRC-0003",
    complaintDate: new Date("2026-06-20T12:00:00.000Z"),
    receivedAt: new Date("2026-06-20T12:03:00.000Z"),
    dueDate: new Date("2026-06-27T12:00:00.000Z"),
    status: ComplaintStatus.IN_PROGRESS,
    subject: "تأخر في استقبال حالة طارئة",
    description: "حالة صناعية متأخرة لاختبار مؤشرات التأخر.",
    region: "الشرقية",
    facility: "مستشفى تجريبي بالدمام",
    department: "إدارة الطوارئ",
    categoryId: accessCategory.id,
    classificationId: emergency.id,
    priority: ComplaintPriority.CRITICAL,
    severity: ComplaintPriority.CRITICAL,
    channel: "منصة الشكاوى الإلكترونية",
    firstActionAt: new Date("2026-06-23T12:00:00.000Z"),
    processingStartedAt: new Date("2026-06-24T12:00:00.000Z"),
    delayReason: "ضغط تشغيلي صناعي",
    importBatchId: confirmedBatch.id,
  }, { actor, importBatchId: confirmedBatch.id });

  const withinSlaComplaint = await createComplaint(db, {
    externalId: "EXT-2026-0004",
    sourceReference: "SRC-0004",
    complaintDate: baseDate,
    receivedAt: new Date("2026-07-15T09:05:00.000Z"),
    dueDate: new Date("2026-08-15T09:00:00.000Z"),
    status: ComplaintStatus.AWAITING_RESPONSE,
    subject: "طلب توضيح إجراء خدمة",
    description: "شكوى صناعية ضمن المهلة لاختبار المؤشرات.",
    region: "الرياض",
    facility: "مركز رعاية تجريبي",
    department: "إدارة الخدمات الطبية",
    categoryId: qualityCategory.id,
    classificationId: staffBehavior.id,
    priority: ComplaintPriority.HIGH,
    severity: ComplaintPriority.MEDIUM,
    channel: "التطبيق الذكي",
  }, { actor });

  await updateComplaintStatus(db, openComplaint.id, ComplaintStatus.IN_PROGRESS, {
    expectedVersion: openComplaint.version,
    actor,
    reason: "Synthetic processing started.",
    importBatchId: confirmedBatch.id,
    changedAt: new Date("2026-07-11T09:00:00.000Z"),
  });

  await db.importBatchRow.createMany({
    data: [
      {
        importBatchId: confirmedBatch.id,
        rowNumber: 1,
        rawData: { externalId: "EXT-2026-0001", subject: "تأخر موعد العيادة" },
        normalizedData: { externalId: "EXT-2026-0001", status: "OPEN" },
        externalId: "EXT-2026-0001",
        action: ImportRowAction.NEW,
        validationStatus: ImportRowValidationStatus.VALID,
        createdComplaintId: openComplaint.id,
      },
      {
        importBatchId: confirmedBatch.id,
        rowNumber: 2,
        rawData: { externalId: "EXT-2026-0002", subject: "ملاحظة على تعامل موظف" },
        normalizedData: { externalId: "EXT-2026-0002", status: "CLOSED" },
        externalId: "EXT-2026-0002",
        action: ImportRowAction.UPDATE,
        validationStatus: ImportRowValidationStatus.WARNING,
        validationWarnings: [{ code: "STATUS_ALREADY_CLOSED", message: "الشكوى مغلقة مسبقاً." }],
        matchedComplaintId: closedComplaint.id,
      },
      {
        importBatchId: confirmedBatch.id,
        rowNumber: 3,
        rawData: { externalId: "EXT-2026-0003", subject: "تأخر في استقبال حالة طارئة" },
        normalizedData: { externalId: "EXT-2026-0003", status: "IN_PROGRESS" },
        externalId: "EXT-2026-0003",
        action: ImportRowAction.DUPLICATE,
        validationStatus: ImportRowValidationStatus.VALID,
        matchedComplaintId: lateComplaint.id,
      },
      {
        importBatchId: confirmedBatch.id,
        rowNumber: 4,
        rawData: { subject: "" },
        normalizedData: { subject: "" },
        action: ImportRowAction.REJECT,
        validationStatus: ImportRowValidationStatus.INVALID,
        validationErrors: [{ code: "SUBJECT_REQUIRED", message: "موضوع الشكوى مطلوب." }],
      },
      {
        importBatchId: readyBatch.id,
        rowNumber: 1,
        rawData: { externalId: "EXT-2026-0005", subject: "صف جديد جاهز" },
        normalizedData: { externalId: "EXT-2026-0005", status: "NEW" },
        externalId: "EXT-2026-0005",
        action: ImportRowAction.NEW,
        validationStatus: ImportRowValidationStatus.VALID,
      },
      {
        importBatchId: readyBatch.id,
        rowNumber: 2,
        rawData: { externalId: "EXT-2026-0004", subject: "طلب توضيح إجراء خدمة" },
        normalizedData: { externalId: "EXT-2026-0004", status: "AWAITING_RESPONSE" },
        externalId: "EXT-2026-0004",
        action: ImportRowAction.UPDATE,
        validationStatus: ImportRowValidationStatus.VALID,
        matchedComplaintId: withinSlaComplaint.id,
      },
    ],
  });

  for (const batch of [confirmedBatch, readyBatch]) {
    await writeAuditLog(db, {
      action: "IMPORT_BATCH_CREATED",
      entityType: "ImportBatch",
      entityId: batch.id,
      actor,
      metadata: { fileHash: batch.fileHash },
    });
    await writeAuditLog(db, {
      action: "IMPORT_BATCH_STATUS_CHANGED",
      entityType: "ImportBatch",
      entityId: batch.id,
      actor,
      metadata: { status: batch.status },
    });
  }

  await writeAuditLog(db, {
    action: "IMPORT_BATCH_CONFIRMED",
    entityType: "ImportBatch",
    entityId: confirmedBatch.id,
    actor,
  });

  await backfillFacilityRegistry(db);
  await db.importBatch.update({
    where: { id: confirmedBatch.id },
    data: {
      facilitySyncStatus: FacilitySyncStatus.COMPLETED,
      facilitySyncAttempts: 1,
      facilitySyncError: null,
      facilitySyncedAt: new Date(),
    },
  });

  await db.reportTemplate.create({
    data: {
      name: "ملخص الشكاوى الشهري التجريبي",
      description: "قالب تجريبي للتقرير التنفيذي الشهري",
      reportType: "EXECUTIVE_SUMMARY",
      filters: {
        from: "2026-07-01",
        to: "2026-07-31",
      },
      options: {
        includeComparison: true,
        includeCharts: true,
        includeDetailedRows: false,
      },
      createdBy: actor,
    },
  });

  console.log("Seed completed successfully!");
  console.log("- 2 categories");
  console.log("- 3 classifications");
  console.log("- 4 complaints");
  console.log("- 2 import batches");
  console.log("- 6 import rows");
  console.log("- 1 report template");
  console.log("- 4 active facilities");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => appDb.$disconnect());
}
