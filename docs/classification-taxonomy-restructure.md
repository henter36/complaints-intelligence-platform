# إعادة هيكلة قاموس التصنيفات

هذه المهمة تحكم تطبيق هيكل التصنيفات الرئيسية والفرعية المقترح دون Backfill للشكاوى غير المصنفة.

## المبادئ

- **Category** = التصنيف الرئيسي (المجال التشغيلي).
- **Classification** = التصنيف الفرعي (سبب الشكوى).
- التجميع بالمعرّفات (`categoryId` / `classificationId`).
- العرض بالمسار الكامل: `categoryName / classificationName`.
- قيمة «أخرى» تذهب إلى `بيانات غير محددة / أخرى تحتاج مراجعة` فقط.
- الشكاوى الأربع المصنفة تُحفظ؛ الشكاوى غير المصنفة لا تُصنَّف في هذا المسار.

## CLI

```bash
npm run classifications:restructure -- \
  --mode=dry-run \
  --proposal=output/classification-review/proposed-classification-taxonomy.json \
  --mapping=output/classification-review/proposed-source-detail-reclassification.csv \
  --manifest=output/classification-taxonomy-restructure-manifest.json \
  --overwrite=true
```

الأوضاع: `dry-run` (الافتراضي) | `apply` | `verify` | `rollback`.

`apply` يتطلب `--manifest` و `--confirm=<token>` من المعاينة. إذا تغيّر القاموس بعد المعاينة يفشل بـ `CLASSIFICATION_TAXONOMY_CHANGED_AFTER_PREVIEW`.

`verify` يتطلب `--run-id` و `--proposal` و `--mapping`.

### Exit codes لـ rollback

| الحالة | Exit code |
|---|---|
| `ROLLED_BACK` | `0` |
| `PARTIALLY_ROLLED_BACK` | `2` |
| أي حالة أخرى / فشل | `1` |

التراجع الجزئي لا يُعد نجاحًا؛ يعني أن بعض العناصر بقيت دون استعادة بسبب تغيير لاحق أو drift.

## الخدمة

المنطق في `src/server/classifications/classification-taxonomy-restructure.ts`.
التحقق من المقترح في `classification-taxonomy-proposal.ts`.
سجل التشغيل: `ClassificationTaxonomyRestructureRun` / `ClassificationTaxonomyRestructureItem`.

بصمات Restructure تعتمد على **shape fingerprint** (أسماء + حالة + كلمات مطبّعة) وليست على cuid.

## ملاحظات

- لا يُنفَّذ Apply على `dev.db` أثناء التطوير إلا بقرار صريح من المستخدم.
- لا يُدمَج مع فرع Historical Backfill.
- ملف XLSX مرجع بشري فقط وليس مصدر ترحيل آلي.
