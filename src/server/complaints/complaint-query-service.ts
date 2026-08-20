import { ComplaintPriority, ComplaintStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { freshnessBucketWhere } from "@/server/analytics/operational/operational-freshness";
import { buildComplaintTiming, type ComplaintTimingSnapshot } from "./complaint-timing";
import {
  CLOSED_COMPLAINT_STATUSES,
  OPEN_COMPLAINT_STATUSES,
} from "./status";
import {
  buildCurrentOperationalFacilityWhere,
  buildHistoricalOperationalFacilityWhere,
  combineComplaintWhere,
} from "@/server/facilities/facility-operational-scope-service";
import { normalizeFacilityName } from "@/server/facilities/facility-name";
import { decodeComplainantToken } from "./complainant-token";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_SORT_BY = "receivedDate";
const DEFAULT_SORT_ORDER = "desc";
const MAX_PAGE_SIZE = 100;
const EXPORT_LIMIT = 10_000;

const SORT_FIELDS = {
  receivedDate: "complaintDate",
  complaintDate: "complaintDate",
  receivedAt: "receivedAt",
  dueDate: "dueDate",
  closedAt: "closedAt",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  priority: "priority",
  severity: "severity",
  status: "status",
  complaintNumber: "externalId",
  externalId: "externalId",
} as const satisfies Record<string, keyof Prisma.ComplaintOrderByWithRelationInput>;

const booleanSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === "") return undefined;
    if (value === "true") return true;
    if (value === "false") return false;
    ctx.addIssue({ code: "custom", message: "must be true or false" });
    return z.NEVER;
  });

const dateSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "must be a valid date" });
      return z.NEVER;
    }
    return date;
  });

const optionalText = z.string().trim().optional().transform((value) => value || undefined);

const querySchema = z.object({
  page: z.coerce.number().int().positive().default(DEFAULT_PAGE),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  search: optionalText,
  externalId: optionalText,
  sourceReference: optionalText,
  status: z.string().optional().transform((value, ctx) => parseStatusValue(value, ctx)),
  priority: z.string().optional().transform((value, ctx) => parseEnumValue(value, ComplaintPriority, ctx, "priority")),
  severity: z.string().optional().transform((value, ctx) => parseEnumValue(value, ComplaintPriority, ctx, "severity")),
  channel: optionalText,
  region: optionalText,
  regionId: optionalText,
  facility: optionalText,
  facilityId: optionalText,
  department: optionalText,
  departmentId: optionalText,
  categoryId: optionalText,
  classificationId: optionalText,
  /**
   * Opaque, server-decoded drillthrough token (never the raw identifier —
   * see complainant-token.ts) from the repeat-complainant directory. Never
   * exposed as a general free-text field; nothing sets this except that
   * one drillthrough flow.
   */
  complainantToken: optionalText,
  importBatchId: optionalText,
  operationalScope: z.enum(["current", "historical"]).optional(),
  from: dateSchema,
  to: dateSchema,
  dueFrom: dateSchema,
  dueTo: dateSchema,
  closedFrom: dateSchema,
  closedTo: dateSchema,
  sourceOrigin: optionalText,
  sourceStatus: optionalText,
  sourceActionStatus: optionalText,
  wingCode: optionalText,
  sourceUpdatedFrom: dateSchema,
  sourceUpdatedTo: dateSchema,
  sourceModifiedFrom: dateSchema,
  sourceModifiedTo: dateSchema,
  hasActionTaken: booleanSchema,
  hasActionDescription: booleanSchema,
  hasResolution: booleanSchema,
  hasClosedAt: booleanSchema,
  hasSourceModifiedAt: booleanSchema,
  dataFreshnessBucket: z
    .enum(["fresh_1d", "stale_1_3d", "stale_3_7d", "stale_7d_plus", "missing"])
    .optional(),
  isLate: booleanSchema,
  isOpen: booleanSchema,
  isClosed: booleanSchema,
  hasDueDate: booleanSchema,
  hasClassification: booleanSchema,
  isRepeated: booleanSchema,
  isValidated: booleanSchema,
  aiAnalyzed: booleanSchema,
  sortBy: z.string().default(DEFAULT_SORT_BY),
  sortOrder: z.enum(["asc", "desc"]).default(DEFAULT_SORT_ORDER),
});

export type ComplaintQuery = z.infer<typeof querySchema>;
export type ComplaintSortKey = keyof typeof SORT_FIELDS;

export class ComplaintQueryValidationError extends Error {
  readonly code = "INVALID_COMPLAINT_QUERY";

  constructor(message: string) {
    super(message);
    this.name = "ComplaintQueryValidationError";
  }
}

export type ComplaintListItem = {
  id: string;
  externalId: string | null;
  sourceReference: string | null;
  complaintNumber: string;
  complaintDate: string | null;
  receivedAt: string;
  receivedDate: string;
  dueDate: string | null;
  closedAt: string | null;
  status: ComplaintStatus;
  rawStatus: ComplaintStatus;
  subject: string;
  region: { name: string } | null;
  regionName: string | null;
  facility: string | null;
  location: { name: string } | null;
  department: { name: string } | null;
  departmentName: string | null;
  category: { id: string; name: string } | null;
  classification: { id: string; name: string; color: string | null } | null;
  priority: ComplaintPriority;
  severity: ComplaintPriority;
  channel: string | null;
  isCurrentlyLate: boolean;
  wasClosedLate: boolean;
  isClosedWithinDueDate: boolean;
  isLate: boolean;
  latenessDays: number | null;
  resolutionDays: number | null;
  version: number;
  updatedAt: string;
};

export type ComplaintListResult = {
  items: ComplaintListItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  appliedFilters: Record<string, unknown>;
  where: Prisma.ComplaintWhereInput;
};

const complaintListSelect = {
  id: true,
  externalId: true,
  sourceReference: true,
  complaintDate: true,
  receivedAt: true,
  dueDate: true,
  closedAt: true,
  status: true,
  subject: true,
  region: true,
  facility: true,
  department: true,
  categoryId: true,
  classificationId: true,
  priority: true,
  severity: true,
  channel: true,
  version: true,
  updatedAt: true,
  category: { select: { id: true, nameAr: true } },
  classification: { select: { id: true, nameAr: true, color: true } },
} satisfies Prisma.ComplaintSelect;

type ComplaintListRecord = Prisma.ComplaintGetPayload<{ select: typeof complaintListSelect }>;

const COMPLAINT_STATUS_ALIASES = {
  NEW: ComplaintStatus.NEW,
  OPEN: ComplaintStatus.OPEN,
  IN_PROGRESS: ComplaintStatus.IN_PROGRESS,
  AWAITING_RESPONSE: ComplaintStatus.AWAITING_RESPONSE,
  RESOLVED: ComplaintStatus.RESOLVED,
  CLOSED: ComplaintStatus.CLOSED,
  CANCELLED: ComplaintStatus.CANCELLED,
  REJECTED: ComplaintStatus.CANCELLED,
  REOPENED: ComplaintStatus.OPEN,
} as const satisfies Record<string, ComplaintStatus>;

function parseStatusValue(
  value: string | undefined,
  ctx: z.RefinementCtx
): ComplaintStatus | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  const status = COMPLAINT_STATUS_ALIASES[normalized as keyof typeof COMPLAINT_STATUS_ALIASES];
  if (!status) {
    ctx.addIssue({ code: "custom", message: "status is not supported" });
    return z.NEVER;
  }
  return status;
}

function parseEnumValue<T extends Record<string, string>>(
  value: string | undefined,
  choices: T,
  ctx: z.RefinementCtx,
  fieldName: string
): T[keyof T] | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  const match = Object.values(choices).find((choice) => choice === normalized);
  if (!match) {
    ctx.addIssue({ code: "custom", message: `${fieldName} is not supported` });
    return z.NEVER;
  }
  return match as T[keyof T];
}

export function parseComplaintQuery(params: URLSearchParams): ComplaintQuery {
  const raw = Object.fromEntries(params.entries());
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ComplaintQueryValidationError(parsed.error.issues[0]?.message ?? "Invalid complaint query");
  }
  if (!(parsed.data.sortBy in SORT_FIELDS)) {
    throw new ComplaintQueryValidationError("sortBy is not supported");
  }
  validateRange(parsed.data.from, parsed.data.to, "from", "to");
  validateRange(parsed.data.dueFrom, parsed.data.dueTo, "dueFrom", "dueTo");
  validateRange(parsed.data.closedFrom, parsed.data.closedTo, "closedFrom", "closedTo");
  validateRange(parsed.data.sourceUpdatedFrom, parsed.data.sourceUpdatedTo, "sourceUpdatedFrom", "sourceUpdatedTo");
  validateRange(
    parsed.data.sourceModifiedFrom,
    parsed.data.sourceModifiedTo,
    "sourceModifiedFrom",
    "sourceModifiedTo"
  );
  return parsed.data;
}

export function isComplaintQueryValidationError(error: unknown): error is ComplaintQueryValidationError {
  return error instanceof ComplaintQueryValidationError;
}

function validateRange(start: Date | undefined, end: Date | undefined, startName: string, endName: string): void {
  if (start && end && start > end) {
    throw new ComplaintQueryValidationError(`${startName} must be before or equal to ${endName}`);
  }
}

function addAnd(where: Prisma.ComplaintWhereInput, condition: Prisma.ComplaintWhereInput): void {
  const current = where.AND;
  if (!current) {
    where.AND = [condition];
    return;
  }
  where.AND = Array.isArray(current) ? [...current, condition] : [current, condition];
}

/** Calendar `YYYY-MM-DD` values parse as UTC midnight; inclusive `to` must cover that whole day. */
function startOfNextUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

function dateRange(from?: Date, to?: Date): Prisma.DateTimeNullableFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lt: startOfNextUtcDay(to) } : {}),
  };
}

export function buildComplaintWhere(query: ComplaintQuery, now = new Date()): Prisma.ComplaintWhereInput {
  const where: Prisma.ComplaintWhereInput = { isDeleted: false };
  applyIdentityFilters(where, query);
  applyScalarFilters(where, query);
  applyDateFilters(where, query);
  applyOperationalScalarFilters(where, query, now);
  applyTextSearch(where, query.search);
  applyBooleanFilters(where, query, now);
  return where;
}

function applyIdentityFilters(where: Prisma.ComplaintWhereInput, query: ComplaintQuery): void {
  if (query.externalId) where.externalId = { contains: query.externalId };
  if (query.sourceReference) where.sourceReference = { contains: query.sourceReference };
  if (query.importBatchId) where.importBatchId = query.importBatchId;
}

function applyScalarFilters(where: Prisma.ComplaintWhereInput, query: ComplaintQuery): void {
  if (query.status) where.status = query.status;
  if (query.priority) where.priority = query.priority;
  if (query.severity) where.severity = query.severity;
  if (query.channel) where.channel = query.channel;
  if (query.region ?? query.regionId) where.region = query.region ?? query.regionId;
  const selectedFacility = query.facility ?? query.facilityId;
  if (selectedFacility) {
    const canonicalKey = normalizeFacilityName(selectedFacility);
    where.facilityNormalizedName = canonicalKey ?? "__INVALID_FACILITY_KEY__";
  }
  if (query.department ?? query.departmentId) where.department = query.department ?? query.departmentId;
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.classificationId) where.classificationId = query.classificationId;
  if (query.complainantToken) {
    // A malformed/foreign/tampered token must filter to nothing, never to
    // "no filter at all" — that would silently widen the result set to
    // every complaint instead of failing closed.
    const decoded = decodeComplainantToken(query.complainantToken);
    where.complainantIdentifier = decoded ?? "__INVALID_COMPLAINANT_TOKEN__";
  }
  if (query.isRepeated !== undefined) where.isRepeated = query.isRepeated;
  if (query.isValidated !== undefined) where.isValidated = query.isValidated;
  if (query.aiAnalyzed !== undefined) where.aiAnalyzedAt = query.aiAnalyzed ? { not: null } : null;
}

function applyDateFilters(where: Prisma.ComplaintWhereInput, query: ComplaintQuery): void {
  const complaintDate = dateRange(query.from, query.to);
  if (complaintDate) where.complaintDate = complaintDate;
  const dueDate = dateRange(query.dueFrom, query.dueTo);
  if (dueDate) where.dueDate = dueDate;
  const closedAt = dateRange(query.closedFrom, query.closedTo);
  if (closedAt) where.closedAt = closedAt;
}

const OPERATIONAL_UNSPECIFIED = "__UNSPECIFIED__";

function applyOperationalScalarFilters(
  where: Prisma.ComplaintWhereInput,
  query: ComplaintQuery,
  now: Date
): void {
  applyCategoricalOrUnspecified(where, "sourceOrigin", query.sourceOrigin);
  applyCategoricalOrUnspecified(where, "sourceStatus", query.sourceStatus);
  applyCategoricalOrUnspecified(where, "sourceActionStatus", query.sourceActionStatus);
  applyCategoricalOrUnspecified(where, "wingCode", query.wingCode);

  const sourceUpdated = dateRange(query.sourceUpdatedFrom, query.sourceUpdatedTo);
  if (sourceUpdated) where.sourceUpdatedAt = sourceUpdated;
  const sourceModified = dateRange(query.sourceModifiedFrom, query.sourceModifiedTo);
  if (sourceModified) where.sourceModifiedAt = sourceModified;

  if (query.hasActionTaken === true) {
    addAnd(where, { AND: [{ actionTaken: { not: null } }, { NOT: { actionTaken: "" } }] });
  }
  if (query.hasActionTaken === false) {
    addAnd(where, { OR: [{ actionTaken: null }, { actionTaken: "" }] });
  }
  if (query.hasActionDescription === true) {
    addAnd(where, { AND: [{ actionDescription: { not: null } }, { NOT: { actionDescription: "" } }] });
  }
  if (query.hasActionDescription === false) {
    addAnd(where, { OR: [{ actionDescription: null }, { actionDescription: "" }] });
  }
  if (query.hasResolution === true) {
    addAnd(where, { AND: [{ resolution: { not: null } }, { NOT: { resolution: "" } }] });
  }
  if (query.hasResolution === false) {
    addAnd(where, { OR: [{ resolution: null }, { resolution: "" }] });
  }
  if (query.hasClosedAt === true) addAnd(where, { closedAt: { not: null } });
  if (query.hasClosedAt === false) addAnd(where, { closedAt: null });
  if (query.hasSourceModifiedAt === true) addAnd(where, { sourceModifiedAt: { not: null } });
  if (query.hasSourceModifiedAt === false) addAnd(where, { sourceModifiedAt: null });

  if (query.dataFreshnessBucket) {
    addAnd(where, freshnessBucketWhere(query.dataFreshnessBucket, now));
  }
}

function applyCategoricalOrUnspecified(
  where: Prisma.ComplaintWhereInput,
  field: "sourceOrigin" | "sourceStatus" | "sourceActionStatus" | "wingCode",
  value: string | undefined
): void {
  if (!value) return;
  if (value === OPERATIONAL_UNSPECIFIED) {
    addAnd(where, { OR: [{ [field]: null }, { [field]: "" }] });
    return;
  }
  where[field] = value;
}

function applyTextSearch(where: Prisma.ComplaintWhereInput, search?: string): void {
  if (!search) return;
  addAnd(where, {
    OR: [
      { externalId: { contains: search } },
      { sourceReference: { contains: search } },
      { subject: { contains: search } },
      { description: { contains: search } },
      { actionDescription: { contains: search } },
      { sourceDetail: { contains: search } },
    ],
  });
}

function applyBooleanFilters(where: Prisma.ComplaintWhereInput, query: ComplaintQuery, now: Date): void {
  if (query.isOpen === true) addAnd(where, { status: { in: [...OPEN_COMPLAINT_STATUSES] } });
  if (query.isOpen === false) addAnd(where, { status: { notIn: [...OPEN_COMPLAINT_STATUSES] } });
  if (query.isClosed === true) addAnd(where, { status: { in: [...CLOSED_COMPLAINT_STATUSES] } });
  if (query.isClosed === false) addAnd(where, { status: { notIn: [...CLOSED_COMPLAINT_STATUSES] } });
  if (query.hasDueDate === true) addAnd(where, { dueDate: { not: null } });
  if (query.hasDueDate === false) addAnd(where, { dueDate: null });
  if (query.hasClassification === true) addAnd(where, { classificationId: { not: null } });
  if (query.hasClassification === false) addAnd(where, { classificationId: null });
  if (query.isLate === true) {
    addAnd(where, buildCurrentlyLateWhere(now));
  }
  if (query.isLate === false) {
    addAnd(where, {
      OR: [
        { dueDate: null },
        { dueDate: { gte: now } },
        { status: { notIn: [...OPEN_COMPLAINT_STATUSES] } },
      ],
    });
  }
}

/** Open complaints with a due date strictly before `now` (currently overdue). */
export function buildCurrentlyLateWhere(now: Date): Prisma.ComplaintWhereInput {
  return {
    dueDate: { lt: now },
    status: { in: [...OPEN_COMPLAINT_STATUSES] },
  };
}

export function buildComplaintOrderBy(query: ComplaintQuery): Prisma.ComplaintOrderByWithRelationInput[] {
  const sortField = SORT_FIELDS[query.sortBy as ComplaintSortKey];
  return [{ [sortField]: query.sortOrder }, { id: query.sortOrder }];
}

/**
 * Deterministic, facility-grouped ordering for report complaint-detail
 * tables (region -> facility -> complaint date desc, tie-broken by
 * externalId/id) — NOT part of `SORT_FIELDS`/the public `sortBy` query
 * param, and never will be: widening the general complaints-explorer sort
 * vocabulary isn't needed just to fix report output, and every general
 * list/export caller keeps its existing date-based default untouched.
 * Pass directly as `listComplaints()`'s own `orderBy` option (report-data-
 * service.ts's `fetchDetailTable` is the only caller).
 *
 * `region`/`facilityNormalizedName` (not raw `facility`) are the sort
 * keys — `facilityNormalizedName` is the canonical, Arabic-normalized key
 * already used for facility matching/grouping elsewhere (facility-name.ts,
 * facility-operational-scope-service.ts), so two spellings of the same
 * facility never get split into separate groups. It's null exactly when a
 * complaint has no (or an "غير محدد") facility; `nulls: "last"` on both
 * region and facility keeps that group at the very end instead of
 * interleaving with named regions/facilities (SQLite's default ASC
 * ordering sorts NULLs FIRST, which would do the opposite).
 */
export function buildReportComplaintOrderBy(): Prisma.ComplaintOrderByWithRelationInput[] {
  return [
    { region: { sort: "asc", nulls: "last" } },
    { facilityNormalizedName: { sort: "asc", nulls: "last" } },
    { complaintDate: { sort: "desc", nulls: "last" } },
    { receivedAt: "desc" },
    { externalId: { sort: "asc", nulls: "last" } },
    { id: "asc" },
  ];
}

export async function listComplaints(
  params: URLSearchParams,
  options: { now?: Date; limit?: number; orderBy?: Prisma.ComplaintOrderByWithRelationInput[] } = {}
): Promise<ComplaintListResult> {
  const query = parseComplaintQuery(params);
  const now = options.now ?? new Date();
  const baseWhere = buildComplaintWhere(query, now);
  let facilityWhere: Prisma.ComplaintWhereInput = {};
  if (query.operationalScope === "current") {
    facilityWhere = await buildCurrentOperationalFacilityWhere();
  } else if (query.operationalScope === "historical") {
    facilityWhere = await buildHistoricalOperationalFacilityWhere();
  }
  const where = combineComplaintWhere(baseWhere, facilityWhere);
  const pageSize = options.limit ? Math.min(options.limit, EXPORT_LIMIT) : query.pageSize;
  const skip = (query.page - 1) * query.pageSize;

  if (!Number.isSafeInteger(skip)) {
    throw new ComplaintQueryValidationError("Requested page is outside the supported range");
  }

  const [records, total] = await Promise.all([
    db.complaint.findMany({
      where,
      select: complaintListSelect,
      // The report-only orderBy override, when present, is applied here —
      // still by Prisma/SQLite BEFORE `take`, so a facility-grouped ORDER
      // BY always precedes the LIMIT at the SQL level (never a JS re-sort
      // of an already-limited, date-ordered page).
      orderBy: options.orderBy ?? buildComplaintOrderBy(query),
      skip: options.limit ? 0 : skip,
      take: pageSize,
    }),
    db.complaint.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.pageSize);
  return {
    items: records.map((record) => toComplaintListItem(record, now)),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1,
    },
    appliedFilters: appliedFilters(query),
    where,
  };
}

function appliedFilters(query: ComplaintQuery): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query).filter(([key, value]) => {
      if (value === undefined || value === "") {
        return false;
      }

      if (key === "page" && value === DEFAULT_PAGE) {
        return false;
      }

      if (key === "pageSize" && value === DEFAULT_PAGE_SIZE) {
        return false;
      }

      if (key === "sortBy" && value === DEFAULT_SORT_BY) {
        return false;
      }

      if (key === "sortOrder" && value === DEFAULT_SORT_ORDER) {
        return false;
      }

      return true;
    })
  );
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toComplaintListItem(record: ComplaintListRecord, now = new Date()): ComplaintListItem {
  const timing = buildComplaintTiming(record satisfies ComplaintTimingSnapshot, now);
  return {
    id: record.id,
    externalId: record.externalId,
    sourceReference: record.sourceReference,
    complaintNumber: record.externalId ?? record.sourceReference ?? record.id,
    complaintDate: iso(record.complaintDate),
    receivedAt: record.receivedAt.toISOString(),
    receivedDate: (record.complaintDate ?? record.receivedAt).toISOString(),
    dueDate: iso(record.dueDate),
    closedAt: iso(record.closedAt),
    status: record.status,
    rawStatus: record.status,
    subject: record.subject,
    region: record.region ? { name: record.region } : null,
    regionName: record.region,
    facility: record.facility,
    location: record.facility ? { name: record.facility } : null,
    department: record.department ? { name: record.department } : null,
    departmentName: record.department,
    category: record.category ? { id: record.category.id, name: record.category.nameAr } : null,
    classification: record.classification
      ? { id: record.classification.id, name: record.classification.nameAr, color: record.classification.color }
      : null,
    priority: record.priority,
    severity: record.severity,
    channel: record.channel,
    isCurrentlyLate: timing.isCurrentlyLate,
    wasClosedLate: timing.wasClosedLate,
    isClosedWithinDueDate: timing.isClosedWithinDueDate,
    isLate: timing.isCurrentlyLate || timing.wasClosedLate,
    latenessDays: timing.latenessDays,
    resolutionDays: timing.resolutionDays,
    version: record.version ?? 1,
    updatedAt: (record.updatedAt ?? record.receivedAt).toISOString(),
  };
}

export const COMPLAINT_LIST_SELECT = complaintListSelect;
export const COMPLAINT_EXPORT_LIMIT = EXPORT_LIMIT;
