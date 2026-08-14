import type {
  CandidateClassification,
  ClassificationRequest,
  SemanticCatalogEntry,
} from "./llm-classification-contract";

function compactCandidate(candidate: CandidateClassification) {
  return {
    classificationId: candidate.classificationId,
    classificationName: candidate.classificationName,
    categoryId: candidate.categoryId,
    categoryName: candidate.categoryName,
    keywords: candidate.keywords,
    semanticDefinition: candidate.semanticDefinition,
    includedConcepts: candidate.includedConcepts,
    excludedConcepts: candidate.excludedConcepts,
    confusableWith: candidate.confusableWith,
  };
}

export function classifierInstructions(): string {
  return [
    "أنت مصنف شكاوى إداري. حدد الموضوع الفعلي من مضمون subject وdescription.",
    "sourceDetail إشارة مساعدة وليست حقيقة حاكمة، والكلمات المفتاحية evidence وليست الحكم النهائي.",
    "اختر فقط Classification ID وCategory ID من قائمة المرشحين المسموحة ولا تنشئ تصنيفًا جديدًا.",
    "إذا كان التصنيف الحالي الأنسب فأعد KEEP. إذا كان بديل آخر أوضح بوضوح فأعد CHANGE.",
    "إذا كانت الأدلة غير كافية أو ملتبسة فأعد REVIEW. لا تستخدم معلومات غير موجودة ولا تخمن.",
    "أعط سببًا مختصرًا فقط دون خطوات التفكير ودون نسخ مطول من نص الشكوى.",
  ].join("\n");
}

/** Complaint and candidate taxonomy intentionally precede the current assignment. */
export function buildClassifierInput(request: ClassificationRequest): string {
  const complaintSection = {
    complaint: request.complaint,
    allowedCandidateTaxonomy: request.candidates.map(compactCandidate),
  };
  const currentAssignmentSection = {
    currentSystemAssignmentMayBeWrong: {
      classificationId: request.currentClassificationId,
      categoryId: request.currentCategoryId,
    },
  };
  return `${JSON.stringify(complaintSection)}\n${JSON.stringify(currentAssignmentSection)}`;
}

export function verifierInstructions(): string {
  return [
    "أنت مدقق مستقل لاقتراح تغيير تصنيف شكوى إدارية.",
    "قيّم النص المنقح نفسه والتصنيف الحالي والمقترح والبدائل دون الاعتماد على rationale المصنف.",
    "وافق فقط عندما يدعم النص التصنيف المقترح بوضوح. ارفضه إذا كان الحالي أو بديل آخر أدق.",
    "استخدم REVIEW عند الغموض. اختر supportedClassificationId فقط من IDs المعطاة.",
    "أعط سببًا مختصرًا دون خطوات التفكير ودون نسخ مطول من نص الشكوى.",
  ].join("\n");
}

function definition(entry: SemanticCatalogEntry | undefined) {
  if (!entry) return null;
  return {
    classificationId: entry.classificationId,
    classificationName: entry.classificationName,
    categoryId: entry.categoryId,
    categoryName: entry.categoryName,
    semanticDefinition: entry.semanticDefinition,
    includedConcepts: entry.includedConcepts,
    excludedConcepts: entry.excludedConcepts,
  };
}

export function buildVerifierInput(input: {
  request: ClassificationRequest;
  current: SemanticCatalogEntry | undefined;
  proposed: SemanticCatalogEntry;
}): string {
  return JSON.stringify({
    complaint: input.request.complaint,
    currentAssignmentMayBeWrong: definition(input.current),
    proposedAssignment: definition(input.proposed),
    candidateAlternatives: input.request.candidates
      .filter((entry) => entry.classificationId !== input.proposed.classificationId)
      .map(compactCandidate),
  });
}
