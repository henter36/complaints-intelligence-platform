import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

export class ReportStorageError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ReportStorageError";
    this.code = code;
    this.status = status;
  }
}

export type StoredReportFile = {
  storageKey: string;
  fileSize: number;
  sha256: string;
};

const EXTENSION_BY_FORMAT = {
  PDF: "pdf",
  XLSX: "xlsx",
} as const;

export type ReportFileFormat = keyof typeof EXTENSION_BY_FORMAT;

function storageRoot(): string {
  return path.resolve(env.reportStoragePath);
}

function resolveSafePath(storageKey: string): string {
  const root = storageRoot();
  const filePath = path.join(root, path.basename(storageKey));
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    throw new ReportStorageError("REPORT_STORAGE_PATH_INVALID", "مسار تخزين التقرير غير آمن", 500);
  }
  return filePath;
}

export function calculateSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function getReportMaxFileSizeBytes(): number {
  return env.reportMaxFileSizeMb * 1024 * 1024;
}

export async function storeReportArtifact(
  buffer: Buffer,
  format: ReportFileFormat
): Promise<StoredReportFile> {
  const maxBytes = getReportMaxFileSizeBytes();
  if (buffer.length > maxBytes) {
    throw new ReportStorageError(
      "REPORT_FILE_TOO_LARGE",
      "حجم ملف التقرير يتجاوز الحد المسموح",
      413
    );
  }

  const storageKey = `${randomUUID()}.${EXTENSION_BY_FORMAT[format]}`;
  const filePath = resolveSafePath(storageKey);
  const root = storageRoot();

  await mkdir(root, { recursive: true, mode: 0o700 });

  try {
    await writeFile(filePath, buffer, { mode: 0o600 });
  } catch {
    throw new ReportStorageError("REPORT_STORAGE_WRITE_FAILED", "تعذر حفظ ملف التقرير", 500);
  }

  return {
    storageKey,
    fileSize: buffer.length,
    sha256: calculateSha256(buffer),
  };
}

export async function readReportArtifact(storageKey: string): Promise<Buffer> {
  const filePath = resolveSafePath(storageKey);
  try {
    return await readFile(filePath);
  } catch {
    throw new ReportStorageError("REPORT_FILE_NOT_AVAILABLE", "ملف التقرير غير متاح", 404);
  }
}

export type ArtifactDeleteResult = { deleted: true } | { deleted: false; reason: "DELETE_FAILED"; error: Error };

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

export async function deleteReportArtifact(storageKey: string | null | undefined): Promise<ArtifactDeleteResult> {
  if (!storageKey) return { deleted: true };
  try {
    const filePath = resolveSafePath(storageKey);
    await unlink(filePath);
    return { deleted: true };
  } catch (error) {
    // A file that is already gone counts as a successful deletion — there is
    // nothing left to clean up and the caller's row-level tracking can proceed.
    if (isEnoentError(error)) return { deleted: true };
    return {
      deleted: false,
      reason: "DELETE_FAILED",
      error: error instanceof Error ? error : new Error("Unknown artifact deletion failure"),
    };
  }
}
