import { PrismaClient, type Prisma } from "@prisma/client";
import {
  analyzeClassificationCoverage,
  analyzeCurrentResolverCoverage,
  type ClassificationDiagnosticImportRow,
} from "../src/server/classifications/classification-coverage-diagnostic";

const prisma = new PrismaClient();
const ID_BATCH_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function parseDateArg(name: string): Date {
  const value = readArg(name);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`استخدم --${name}=YYYY-MM-DD`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  const normalizedValue = Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
  if (normalizedValue !== value) {
    throw new TypeError(`قيمة --${name} غير صالحة`);
  }

  return date;
}

function effectiveDateWhere(from: Date, toExclusive: Date): Prisma.ComplaintWhereInput {
  return {
    isDeleted: false,
    OR: [
      { complaintDate: { gte: from, lt: toExclusive } },
      {
        complaintDate: null,
        receivedAt: { gte: from, lt: toExclusive },
      },
    ],
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function fetchImportRows(complaintIds: readonly string[]): Promise<ClassificationDiagnosticImportRow[]> {
  const rows: ClassificationDiagnosticImportRow[] = [];
  for (const ids of chunks(complaintIds, ID_BATCH_SIZE)) {
    const batch = await prisma.importBatchRow.findMany({
      where: {
        OR: [
          { createdComplaintId: { in: ids } },
          { matchedComplaintId: { in: ids } },
        ],
      },
      select: {
        createdComplaintId: true,
        matchedComplaintId: true,
        normalizedData: true,
        validationWarnings: true,
        createdAt: true,
      },
    });

    for (const row of batch) {
      const complaintId = row.createdComplaintId ?? row.matchedComplaintId;
      if (!complaintId) continue;
      rows.push({
        complaintId,
        normalizedData: row.normalizedData,
        validationWarnings: row.validationWarnings,
        createdAt: row.createdAt,
      });
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const from = parseDateArg("from");
  const to = parseDateArg("to");
  if (from > to) throw new TypeError("يجب ألا يسبق --to تاريخ --from");
  const toExclusive = new Date(to.getTime() + DAY_MS);

  const [complaints, classifications] = await Promise.all([
    prisma.complaint.findMany({
      where: effectiveDateWhere(from, toExclusive),
      select: {
        id: true,
        classificationId: true,
        sourceDetail: true,
      },
    }),
    prisma.classification.findMany({
      where: {
        isActive: true,
        isDeleted: false,
        category: { isActive: true, isDeleted: false },
      },
      select: {
        id: true,
        nameAr: true,
        keywords: true,
        isActive: true,
        isDeleted: true,
        category: {
          select: {
            id: true,
            nameAr: true,
            isActive: true,
            isDeleted: true,
          },
        },
      },
    }),
  ]);
  const rows = await fetchImportRows(complaints.map((complaint) => complaint.id));
  const historicalCoverage = analyzeClassificationCoverage(complaints, rows);
  const currentResolverCoverage = analyzeCurrentResolverCoverage(
    complaints,
    classifications
  );

  console.log(JSON.stringify({
    period: {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    },
    historicalCoverage,
    currentResolverCoverage,
    taxonomy: {
      activeClassifications: classifications.length,
      classificationsWithKeywords: classifications.filter((item) => {
        return Array.isArray(item.keywords) && item.keywords.length > 0;
      }).length,
    },
  }, null, 2));
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "فشل التشخيص";
    console.error(message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
