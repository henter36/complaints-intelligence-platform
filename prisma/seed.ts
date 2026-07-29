import type { Classification, Department, Location, Region } from "@prisma/client";
import { db } from "../src/lib/db";

const regions = [
  { name: "الرياض", code: "RYD" },
  { name: "مكة المكرمة", code: "MKH" },
  { name: "المدينة المنورة", code: "MDN" },
  { name: "القصيم", code: "QSM" },
  { name: "الشرقية", code: "SHQ" },
  { name: "عسير", code: "ASR" },
  { name: "تبوك", code: "TBK" },
  { name: "حائل", code: "HAIL" },
];

const locations = [
  "مستشفى الملك فيصل التخصصي",
  "مستشفى الملك عبدالعزيز الجامعي",
  "مستشفى الأمير سلطان",
  "مجمع الملك عبدالله الطبي",
  "مستشفى النقاهة",
  "مستشفى الحرس الوطني",
  "مستشفى الأطفال",
  "مستشفى الولادة والأطفال",
  "مركز الرعاية الأولية - النسيم",
  "مركز الرعاية الأولية - العليا",
  "مركز الرعاية الأولية - الملز",
  "مستشفى الملك خالد",
  "مستشفى الأمير محمد بن عبدالعزيز",
  "مستشفى الملك فهد",
  "مجمع عسير الطبي",
];

const departments = [
  { name: "إدارة الخدمات الطبية", code: "MED" },
  { name: "إدارة الطوارئ", code: "EMR" },
  { name: "إدارة المواعيد", code: "APT" },
  { name: "إدارة الصيدلية", code: "PHR" },
  { name: "إدارة المختبرات", code: "LAB" },
  { name: "إدارة الأشعة", code: "RAD" },
  { name: "إدارة التمريض", code: "NUR" },
  { name: "إدارة الاستقبال", code: "RCV" },
  { name: "إدارة الشؤون المالية", code: "FIN" },
  { name: "إدارة الجودة", code: "QLT" },
  { name: "إدارة الصيانة", code: "MNT" },
  { name: "إدارة النظافة", code: "CLN" },
];

const classifications = [
  { name: "جودة الخدمة الطبية", color: "#ef4444", children: ["تأخر العلاج", "خطأ طبي", "عدم استجابة الطاقم"] },
  { name: "المواعيد والانتظار", color: "#f97316", children: ["تأخر المواعيد", "إلغاء الموعد", "صعوبة الحجز"] },
  { name: "المنشآت والمعدات", color: "#eab308", children: ["تعطل الأجهزة", "نقص المعدات", "صيانة الأبنية"] },
  { name: "النظافة والبيئة", color: "#22c55e", children: ["نظافة المرافق", "الروائح", "المياه والصرف"] },
  { name: "السلوك المهني", color: "#06b6d4", children: ["سوء المعاملة", "عدم الالتزام", "التمييز"] },
  { name: "الفوترة والرسوم", color: "#8b5cf6", children: ["فواتير خاطئة", "رسوم مبالغ فيها", "تأخر رد المبالغ"] },
  { name: "الصيدلية والأدوية", color: "#ec4899", children: ["نقص الأدوية", "تأخر الصرف", "أدوية منتهية"] },
  { name: "المختبرات والأشعة", color: "#14b8a6", children: ["تأخر النتائج", "نتائج خاطئة", "صعوبة حجز الأشعة"] },
];

const channels = ["منصة الشكاوى الإلكترونية", "الهاتف الموحد", "البريد الإلكتروني", "التطبيق الذكي", "شبكات التواصل", "الحضور الشخصي", "الإحالة الرسمية"];
const statuses = ["open", "in_progress", "closed", "reopened", "rejected"];
const priorities = ["low", "medium", "high", "critical"];
const severities = ["low", "medium", "high", "critical"];
const subjects = [
  "تأخر طويل في قسم الطوارئ دون متابعة طبية",
  "رفض استقبال المريض بسبب نقص التأمين",
  "تأخر موعد العيادة أكثر من ساعتين",
  "سوء معاملة من موظف الاستقبال",
  "نقص أدوية أساسية في الصيدلية",
  "تأخر نتائج التحاليل لأكثر من أسبوع",
  "عدم توفر أسرّة في العناية المركزة",
  "فاتورة بخدمات لم يتم تقديمها",
  "نظافة غير مطابقة في غرف المرضى",
  "تعطل جهاز الأشعة لفترة طويلة",
  "عدم وجود طبيب مختص في العيادة",
  "تأخر الإسعاف في الوصول للموقع",
  "خطأ في تشخيص الحالة",
  "رفض تحويل المريض لمستشفى متخصص",
  "صعوبة حجز موعد عبر التطبيق",
  "عدم وضوح إجراءات الخروج من المستشفى",
  "ارتفاع رسوم العلاج دون تبرير",
  "عدم استجابة التمريض لنداءات المريض",
  "تكرار نفس الشكوى دون حل جذري",
  "نقص في معدات الحماية للأطقم الطبية",
];
const descriptions = [
  "تقدم المريض بقسم الطوارئ وانتظر أكثر من ثلاث ساعات دون فحص أولي أو توفير سرير، رغم وجود أعراض تستدعي التدخل السريع.",
  "تم رفض استقبال المريض في قسم الاستقبال بحجة عدم اكتمال بيانات التأمين، رغم وجود حالة طارئة تستدعي الرعاية الفورية.",
  "كان الموعد محدداً الساعة التاسعة صباحاً ولم يتم استدعاء المريض إلا بعد الساعة الحادية عشرة، دون تقديم أي اعتذار أو تفسير.",
  "تعرض المريض لمعاملة غير لائقة من قبل موظف الاستقبال الذي رفض تقديم المساعدة وتعامل بأسلوب غير مهني.",
  "تعذر صرف دواء أساسي لمرضى الضغط من الصيدلية بسبب نفاد الكمية، مما اضطر المريض للبحث عنه في صيدليات أخرى.",
  "مرر أكثر من أسبوع على إجراء التحاليل ولم تصدر النتائج بعد، رغم التكرار في الاستفسار ووجود حاجة عاجلة للنتائج.",
  "تعذر توفير سرير في قسم العناية المركزة رغم حالة المريض الحرجة، مما استدعى نقله لمستشفى آخر بعد تأخير طويل.",
  "ظهرت في الفاتورة رسوم خدمات لم يتم تقديمها فعلياً للمريض أثناء فترة الإقامة في المستشفى.",
  "لوحظ وجود قاذورات وروائح كريهة في غرف المرضى ودورات المياه، وعدم التزام النظافة بالمعايير الصحية المطلوبة.",
  "تعطل جهاز الأشعة الرئيسي لأكثر من أسبوع مما أخر تشخيص عدد من الحالات وزاد من معاناة المرضى.",
];
const delayReasons = [
  "نقص الكوادر الطبية المتخصصة",
  "ضغط العمل وعدم كفاية الأسرّة",
  "تعطل الأنظمة الإلكترونية",
  "تأخر وصول النتائج المخبرية",
  "إجراءات إدارية معقدة",
  "نقص الميزانية للمعدات",
  "غياب التنسيق بين الأقسام",
  null,
];
const resolutions = [
  "تمت معالجة الشكوى وتقديم الاعتذار للمستفيد مع اتخاذ إجراءات تصحيحية لمنع التكرار.",
  "تم تحويل الشكوى للإدارة المختصة واتخاذ الإجراءات اللازمة وتحديث الإجراءات.",
  "تم علاج المشكلة فوراً وإجراء تقييم شامل للأقسام ذات العلاقة.",
  "تمت معالجة الحالة وتقديم تعويض للمستفيد وتحسين الخدمة.",
  "تم رفض الشكوى لعدم ثبوت صحتها بعد التحقق.",
  "تم إعادة فتح الشكوى لعدم رضا المستفيد عن الحل المقدم.",
  null,
];

function randomDate(start: Date, end: Date) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function pickMany<T>(arr: T[], n: number): T[] { return [...arr].sort(() => Math.random() - 0.5).slice(0, n); }
function isPresent<T>(value: T | null): value is T { return value !== null; }

async function seed() {
  console.log("Seeding database...");

  await db.auditLog.deleteMany();
  await db.complaintHistory.deleteMany();
  await db.complaint.deleteMany();
  await db.importBatch.deleteMany();
  await db.reportTemplate.deleteMany();
  await db.location.deleteMany();
  await db.region.deleteMany();
  await db.department.deleteMany();
  await db.classification.deleteMany();
  await db.user.deleteMany();

  // Create user
  const user = await db.user.create({
    data: { email: "admin@shakawi.gov.sa", name: "مدير النظام", role: "admin" },
  });

  // Create regions
  const regionRecords: Region[] = [];
  for (const r of regions) {
    regionRecords.push(await db.region.create({ data: r }));
  }

  // Create locations
  const locationRecords: Location[] = [];
  for (let i = 0; i < locations.length; i++) {
    const region = regionRecords[i % regionRecords.length];
    locationRecords.push(await db.location.create({
      data: { name: locations[i], regionId: region.id },
    }));
  }

  // Create departments
  const deptRecords: Department[] = [];
  for (const d of departments) {
    deptRecords.push(await db.department.create({ data: d }));
  }

  // Create classifications with children
  const classRecords: Classification[] = [];
  for (const c of classifications) {
    const parent = await db.classification.create({
      data: { name: c.name, color: c.color, description: `تصنيف رئيسي: ${c.name}` },
    });
    classRecords.push(parent);
    for (const childName of c.children) {
      await db.classification.create({
        data: { name: childName, parentId: parent.id, color: c.color },
      });
    }
  }

  // Create an import batch
  const batch = await db.importBatch.create({
    data: {
      fileName: "شكاوى_أكتوبر_2024.xlsx",
      fileSize: 245760,
      periodType: "monthly",
      periodStart: new Date(2024, 9, 1),
      periodEnd: new Date(2024, 9, 31),
      entity: "جميع المناطق",
      status: "approved",
      totalRecords: 248,
      validRecords: 240,
      newRecords: 220,
      updatedRecords: 20,
      duplicateRecords: 5,
      rejectedRecords: 3,
      incompleteRecords: 0,
      uploadedById: user.id,
      approvedById: user.id,
      approvedAt: new Date(2024, 10, 2),
      createdAt: new Date(2024, 10, 1),
    },
  });

  // Generate 240 complaints
  const now = new Date();
  const startDate = new Date(2024, 6, 1); // 4 months of data
  let complaintCounter = 1000;

  for (let i = 0; i < 240; i++) {
    complaintCounter++;
    const complaintNum = `SHK-2024-${complaintCounter}`;
    const receivedDate = randomDate(startDate, now);
    const status = pick(statuses);
    const priority = pick(priorities);
    const severity = pick(severities);
    const region = pick(regionRecords);
    const location = pick(locationRecords.filter(l => l.regionId === region.id)) || pick(locationRecords);
    const department = pick(deptRecords);
    const parentClass = pick(classRecords);
    const children = await db.classification.findMany({ where: { parentId: parentClass.id } });
    const subClass = children.length > 0 ? pick(children) : null;
    const subject = pick(subjects);
    const description = pick(descriptions);
    const channel = pick(channels);

    const dueDate = new Date(receivedDate.getTime() + (Math.random() * 14 + 3) * 24 * 60 * 60 * 1000);
    const referralDate = new Date(receivedDate.getTime() + Math.random() * 24 * 60 * 60 * 1000);
    const firstActionDate = new Date(referralDate.getTime() + Math.random() * 48 * 60 * 60 * 1000);

    let closureDate: Date | null = null;
    let processingDate: Date | null = null;
    let resolution: string | null = null;
    let delayReason: string | null = null;

    if (status === "closed" || status === "reopened") {
      const isLate = firstActionDate.getTime() + 5 * 24 * 60 * 60 * 1000 < dueDate.getTime() && Math.random() > 0.4;
      processingDate = new Date(firstActionDate.getTime() + Math.random() * 7 * 24 * 60 * 60 * 1000);
      closureDate = new Date(processingDate.getTime() + Math.random() * 5 * 24 * 60 * 60 * 1000);
      if (closureDate > dueDate || isLate) {
        delayReason = pick(delayReasons.filter(isPresent));
      }
      resolution = pick(resolutions.filter(isPresent));
    }

    const isValidated = status === "closed" ? Math.random() > 0.2 : Math.random() > 0.7;
    const satisfaction = status === "closed" ? pick([1, 2, 3, 4, 5, 5, 4]) : null;
    const isRepeated = Math.random() > 0.85;

    await db.complaint.create({
      data: {
        complaintNumber: complaintNum,
        receivedDate,
        channel,
        regionId: region.id,
        locationId: location.id,
        departmentId: department.id,
        classificationId: subClass?.id || parentClass.id,
        subClassificationId: subClass?.id,
        subject,
        description,
        status,
        priority,
        severity,
        referralDate,
        firstActionDate,
        processingDate,
        closureDate,
        dueDate,
        resolution,
        delayReason,
        isRepeated,
        isValidated,
        beneficiarySatisfaction: satisfaction,
        importBatchId: batch.id,
        isPotentialDuplicate: Math.random() > 0.9,
      },
    });
  }

  // Create audit logs
  await db.auditLog.create({
    data: {
      userId: user.id,
      action: "approve",
      entity: "import_batch",
      entityId: batch.id,
      details: JSON.stringify({ fileName: batch.fileName, records: batch.totalRecords }),
    },
  });

  console.log("Seed completed successfully!");
  console.log(`- ${regions.length} regions`);
  console.log(`- ${locations.length} locations`);
  console.log(`- ${departments.length} departments`);
  console.log(`- ${classifications.length} main classifications`);
  console.log(`- 240 complaints`);
}

seed().catch(console.error).finally(() => db.$disconnect());
