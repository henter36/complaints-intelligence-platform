# التصنيف التاريخي المحكوم (Historical Classification Backfill)

## لماذا نحتاج هذه العملية؟

الشكاوى القديمة المستوردة قبل ربط `sourceDetail` بقاموس التصنيفات النشط قد تبقى بلا `classificationId` رغم أن قيمة التفصيل تطابق كلمات مفتاحية معتمدة. عملية الـBackfill التاريخية تطبّق التصنيف على هذه الشكاوى بطريقة محكومة قابلة للمعاينة والتحقق والتراجع، دون إعادة رفع ملفات Excel ودون استبدال التصنيفات اليدوية أو الصريحة.

## الفرق بين الكلمات المفتاحية و`classificationId`

- الكلمات المفتاحية جزء من قاموس التصنيفات (taxonomy) وتُستخدم لمطابقة قيم `sourceDetail` أثناء الاستيراد أو الـBackfill.
- `classificationId` هو الحقل المخزَّن على الشكوى ويربطها بتصنيف محدد.
- تغيير اسم التصنيف أو لونه أو فئته ينعكس في العرض عبر العلاقة دون إعادة كتابة صف الشكوى.
- إضافة/حذف/نقل كلمة مفتاحية **لا** يعيد تصنيف الشكاوى القديمة تلقائيًا؛ يؤثر فقط على الاستيرادات الجديدة وعلى أي عملية Backfill/Reclassification مستقلة لاحقة.

## سياسة عدم إعادة التصنيف التلقائي

إدارة التصنيفات عند الحفظ:

- لا تستدعي Backfill.
- لا تعيد كتابة `Complaint.classificationId`.
- تعطيل التصنيف لا يمحو العلاقة التاريخية.
- الحذف الفعلي مرفوض إن وُجدت شكاوى مرتبطة (سياسة المشروع الحالية).

إعادة تقييم البيانات القديمة مستقبلًا ستكون في PR مستقل:

`feat(classifications): add governed historical reclassification`

وستقتصر على مصادر: `SOURCE_DETAIL_RULE` و`HISTORICAL_BACKFILL` فقط.

## مصادر تعيين التصنيف (`classificationAssignmentSource`)

| المصدر | المعنى |
|--------|--------|
| `MANUAL` | اختيار/مسح يدوي من المستخدم |
| `IMPORT_EXPLICIT` | تصنيف صريح من ملف الاستيراد |
| `SOURCE_DETAIL_RULE` | اشتقاق أثناء الاستيراد من `sourceDetail` |
| `HISTORICAL_BACKFILL` | تطبيق عبر عملية الـBackfill الحالية |
| `LEGACY_UNKNOWN` | مصنّف قبل تتبّع المصدر؛ لا يمكن إثبات المصدر |

### حماية المصادر

- `MANUAL` مع `classificationId = null`: محمية من أي تصنيف آلي لاحق.
- `MANUAL` / `IMPORT_EXPLICIT` / `LEGACY_UNKNOWN`: لا تُستبدل بعمليات أتمتة لاحقة لإعادة التصنيف.
- الشكاوى غير المصنّفة ذات `assignmentSource = null` هي المؤهلة للـBackfill.

## LEGACY_UNKNOWN

عند الترحيل، الشكاوى التي لديها `classificationId` وبدون مصدر تعيين تُعلَّم بـ`LEGACY_UNKNOWN` دون تغيير التصنيف نفسه. الشكاوى غير المصنّفة تبقى `null` وتبقى مؤهلة.

## الأوضاع التشغيلية

### Dry Run

- قراءة فقط لقاعدة البيانات.
- لا ينشئ `ClassificationBackfillRun` / `Item` ولا `AuditLog`.
- يكتب `manifest` على نظام الملفات فقط.
- يعرض العدادات والتوزيع حسب التصنيف و`confirmationToken`.

### Apply

يتطلب `--manifest` و`--confirm` المطابق لرمز المعاينة.

1. التحقق من الـmanifest والبصمة والرمز.
2. إنشاء تشغيل بحالة `APPLYING` وعناصر مخططة.
3. تطبيق دفعات داخل معاملات مستقلة (افتراضي 500).
4. تخطي السجلات المتغيرة بدل استبدالها.
5. تسجيل تدقيق إجمالي آمن.

### Verify

`--mode=verify --run-id=...` يتحقق من الثوابت التشغيلية دون إعادة تصنيف. إذا اختلف القاموس الحالي عن بصمة التشغيل يُبلَّغ فقط بـ`CURRENT_TAXONOMY_DIFFERS_FROM_APPLIED_FINGERPRINT`.

### Rollback

`--mode=rollback --run-id=... --confirm=<ROLLBACK_TOKEN>` يعيد القيم السابقة لعناصر `APPLIED` فقط، ويتخطى التعديلات اليدوية أو تغيّر النسخة.

## taxonomyFingerprint

SHA-256 لحمولة مرتبة ثابتة لكل تصنيف نشط: المعرفات، الأسماء، حالة النشاط/الحذف، والفئة، والكلمات المطبّعة مرتبة. أي تغيير في القاموس يغيّر البصمة. اختلاف البصمة عند Apply يوقف العملية بـ`CLASSIFICATION_TAXONOMY_CHANGED`.

## manifestHash وconfirmationToken

1. يُبنى payload بدون `manifestHash` و`confirmationToken`.
2. تُرتَّب المفاتيح والصفوف بشكل ثابت.
3. `manifestHash = SHA-256(canonical JSON)`.
4. `confirmationToken = APPLY-<eligibleCount>-<أول 10 أحرف مشتقة>`.

رمز التراجع:

`ROLLBACK-<appliedCount>-<أول 10 أحرف مشتقة من runId|manifestHash|appliedCount>`

## أهلية الشكوى

- `isDeleted = false`
- `classificationId = null`
- `classificationAssignmentSource = null`
- `sourceDetail` غير فارغ
- التاريخ الفعلي (`complaintDate ?? receivedAt`) داخل الفترة نصف المفتوحة
- نتيجة المطابقة `MATCHED` فقط عبر `resolveSourceDetailClassification`

## أسباب التجاوز

`ALREADY_CLASSIFIED`, `MANUALLY_PROTECTED`, `AMBIGUOUS`, `UNMATCHED`, `MISSING_SOURCE_DETAIL`, `INACTIVE_CLASSIFICATION`, `VERSION_CHANGED`, `SOURCE_DETAIL_CHANGED`, `DELETED_AFTER_PREVIEW`, `TARGET_CHANGED`, `OUTSIDE_PERIOD`، بالإضافة لأسباب تخطي التراجع.

## الدفعات والفشل الجزئي

كل دفعة في transaction مستقلة. فشل غير متوقع يعيد الدفعة الحالية، يوقف الدفعات التالية، ويترك الدفعات السابقة مطبّقة مع حالة `PARTIALLY_APPLIED` أو `FAILED`. لا يوجد تراجع تلقائي.

## النسخ الاحتياطي قبل Apply

قبل Apply على قاعدة حقيقية خذ نسخة متسقة:

```bash
mkdir -p output/backups
sqlite3 prisma/dev.db ".backup 'output/backups/dev-before-classification-backfill.db'"
```

أو أوقف التطبيق وانسخ `dev.db` مع `dev.db-wal` و`dev.db-shm` إن وُجدت.

لا تُنفَّذ النسخة الاحتياطية تلقائيًا بصمت من الأداة.

### استعادة

```bash
# أوقف التطبيق ثم:
cp output/backups/dev-before-classification-backfill.db prisma/dev.db
# احذف wal/shm إن لزم بعد الاستعادة من .backup
```

## أمان الـmanifest وملفات output

- الـmanifest يحتوي معرفات داخلية (`complaintId`) ويجب حفظه بأمان وصلاحيات مقيّدة.
- لا يُخزَّن `sourceDetail` الأصلي ولا نصوص الشكوى ولا بيانات شخصية.
- ملفات `output/classification-backfill-*.json` و`output/backups/` مستبعدة من Git.

## أوامر التشغيل

```bash
DATABASE_URL="file:./dev.db" \
npm run classifications:backfill -- \
  --mode=dry-run \
  --from=2025-09-08 \
  --to=2026-07-15 \
  --manifest=output/classification-backfill-manifest.json \
  --overwrite=true
```

```bash
DATABASE_URL="file:./dev.db" \
npm run classifications:backfill -- \
  --mode=apply \
  --manifest=output/classification-backfill-manifest.json \
  --confirm=<TOKEN>
```

```bash
DATABASE_URL="file:./dev.db" \
npm run classifications:backfill -- \
  --mode=verify \
  --run-id=<RUN_ID>
```

```bash
DATABASE_URL="file:./dev.db" \
npm run classifications:backfill -- \
  --mode=rollback \
  --run-id=<RUN_ID> \
  --confirm=<ROLLBACK_TOKEN>
```

**لا تنفّذ Apply على `dev.db` أثناء التطوير إلا بقرار تشغيلي صريح وبعد نسخة احتياطية.**
