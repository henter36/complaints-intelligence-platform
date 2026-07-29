import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { env } from "@/lib/env";
import { ImportValidationError } from "./import-errors";

const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
  "",
]);

const MAX_UNCOMPRESSED_RATIO = 25;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;

export type StoredImportFile = {
  storageKey: string;
  fileName: string;
  fileHash: string;
  fileSize: number;
  buffer: Buffer;
};

type ZipEntryWithSizes = JSZip.JSZipObject & {
  _data?: {
    compressedSize?: number;
    uncompressedSize?: number;
  };
};

export function getImportLimits() {
  return {
    maxFileSizeBytes: env.importMaxFileSizeMb * 1024 * 1024,
    maxRows: env.importMaxRows,
    maxColumns: env.importMaxColumns,
    maxSheets: env.importMaxSheets,
  };
}

export function isAllowedXlsxFileName(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() === ".xlsx";
}

export function assertSupportedExcelUpload(input: {
  originalFileName: string;
  mimeType: string;
  size: number;
}): void {
  const limits = getImportLimits();

  if (!isAllowedXlsxFileName(input.originalFileName)) {
    throw new ImportValidationError("UNSUPPORTED_IMPORT_FILE_TYPE", "يجب رفع ملف بصيغة .xlsx فقط", 415);
  }

  if (!XLSX_MIME_TYPES.has(input.mimeType)) {
    throw new ImportValidationError("UNSUPPORTED_IMPORT_FILE_TYPE", "نوع ملف Excel غير مدعوم", 415);
  }

  if (input.size > limits.maxFileSizeBytes) {
    throw new ImportValidationError("IMPORT_FILE_TOO_LARGE", "حجم الملف يتجاوز الحد المسموح", 413);
  }
}

export function assertXlsxMagicBytes(buffer: Buffer): void {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new ImportValidationError("INVALID_XLSX_ARCHIVE", "الملف ليس حزمة Excel صالحة", 422);
  }
}

function isUnsafeZipPath(fileName: string): boolean {
  return (
    fileName.startsWith("/") ||
    fileName.startsWith("\\") ||
    fileName.includes("..") ||
    fileName.includes("\\") ||
    /^[a-zA-Z]:/.test(fileName)
  );
}

export async function validateXlsxZip(buffer: Buffer): Promise<JSZip> {
  assertXlsxMagicBytes(buffer);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new ImportValidationError("INVALID_XLSX_ARCHIVE", "تعذر قراءة بنية ملف Excel", 422);
  }

  const entries = Object.values(zip.files) as ZipEntryWithSizes[];
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new ImportValidationError("IMPORT_ZIP_TOO_MANY_ENTRIES", "ملف Excel يحتوي عدد ملفات داخلي كبيرًا", 422);
  }

  let uncompressedSize = 0;
  for (const entry of entries) {
    if (isUnsafeZipPath(entry.name)) {
      throw new ImportValidationError("IMPORT_ZIP_SLIP_DETECTED", "ملف Excel يحتوي مسارًا داخليًا غير آمن", 422);
    }

    if (entry.name === "xl/vbaProject.bin" || entry.name.startsWith("xl/externalLinks/")) {
      throw new ImportValidationError("IMPORT_XLSX_ACTIVE_CONTENT", "ملف Excel يحتوي محتوى نشطًا أو روابط خارجية غير مسموحة", 422);
    }

    uncompressedSize += entry._data?.uncompressedSize ?? 0;
  }

  const uncompressedLimit = Math.min(
    MAX_UNCOMPRESSED_BYTES,
    Math.max(buffer.length * MAX_UNCOMPRESSED_RATIO, getImportLimits().maxFileSizeBytes)
  );

  if (uncompressedSize > uncompressedLimit) {
    throw new ImportValidationError("IMPORT_ZIP_BOMB_DETECTED", "ملف Excel مضغوط بصورة مفرطة", 422);
  }

  if (!zip.file("[Content_Types].xml") || !zip.file("xl/workbook.xml")) {
    throw new ImportValidationError("INVALID_XLSX_STRUCTURE", "ملف Excel لا يحتوي بنية OOXML المطلوبة", 422);
  }

  return zip;
}

export function calculateFileHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function storeImportFile(buffer: Buffer, originalFileName: string): Promise<StoredImportFile> {
  const storageKey = `${randomUUID()}.xlsx`;
  const storageRoot = path.resolve(env.importStoragePath);
  const filePath = path.join(storageRoot, storageKey);

  if (!filePath.startsWith(`${storageRoot}${path.sep}`)) {
    throw new ImportValidationError("IMPORT_STORAGE_PATH_INVALID", "مسار تخزين الاستيراد غير آمن", 500);
  }

  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  await writeFile(filePath, buffer, { mode: 0o600 });

  return {
    storageKey,
    fileName: storageKey,
    fileHash: calculateFileHash(buffer),
    fileSize: buffer.length,
    buffer,
  };
}

export async function deleteStoredImportFile(storageKey: string | null | undefined): Promise<void> {
  if (!storageKey) return;
  const storageRoot = path.resolve(env.importStoragePath);
  const filePath = path.join(storageRoot, path.basename(storageKey));
  if (!filePath.startsWith(`${storageRoot}${path.sep}`)) return;

  try {
    await unlink(filePath);
  } catch {
    // Best-effort cleanup only; callers should not expose filesystem details.
  }
}

export async function readStoredImportFile(storageKey: string): Promise<Buffer> {
  const storageRoot = path.resolve(env.importStoragePath);
  const filePath = path.join(storageRoot, path.basename(storageKey));
  if (!filePath.startsWith(`${storageRoot}${path.sep}`)) {
    throw new ImportValidationError("IMPORT_STORAGE_PATH_INVALID", "مسار تخزين الاستيراد غير آمن", 500);
  }

  try {
    return await readFile(filePath);
  } catch {
    throw new ImportValidationError("IMPORT_FILE_NOT_AVAILABLE", "ملف الدفعة غير متاح لإعادة المعالجة", 409);
  }
}
