import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { getImportLimits, validateXlsxZip } from "./file-storage";
import { ImportValidationError } from "./import-errors";
import type { RawImportRow } from "./normalization";

type ParsedWorkbook = {
  selectedSheet: string;
  headers: string[];
  rows: RawImportRow[];
  zip: JSZip;
};

type SheetDescriptor = {
  name: string;
  path: string;
  visible: boolean;
};

type CellValue = {
  value: unknown;
  formula: boolean;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
});

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function parseXml<T>(zip: JSZip, fileName: string): Promise<T> {
  const file = zip.file(fileName);
  if (!file) {
    throw new ImportValidationError("INVALID_XLSX_STRUCTURE", `ملف Excel يفتقد ${fileName}`, 422);
  }

  return parser.parse(await file.async("string")) as T;
}

function normalizeTargetPath(target: string): string {
  const normalized = target.replace(/^\/+/, "");
  return normalized.startsWith("xl/") ? normalized : `xl/${normalized}`;
}

async function readSheets(zip: JSZip): Promise<SheetDescriptor[]> {
  const workbook = await parseXml<{
    workbook?: { sheets?: { sheet?: Array<Record<string, string>> | Record<string, string> } };
  }>(zip, "xl/workbook.xml");
  const rels = await parseXml<{
    Relationships?: { Relationship?: Array<Record<string, string>> | Record<string, string> };
  }>(zip, "xl/_rels/workbook.xml.rels");

  const relationById = new Map(
    toArray(rels.Relationships?.Relationship).map((rel) => [rel.Id, rel])
  );

  return toArray(workbook.workbook?.sheets?.sheet).map((sheet) => {
    const rel = relationById.get(sheet["r:id"]);
    if (!rel || rel.TargetMode === "External") {
      throw new ImportValidationError("IMPORT_XLSX_EXTERNAL_LINK", "ملف Excel يحتوي رابطًا خارجيًا غير مسموح", 422);
    }

    return {
      name: sheet.name,
      path: normalizeTargetPath(rel.Target),
      visible: !sheet.state || sheet.state === "visible",
    };
  });
}

async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) return [];

  const shared = parser.parse(await file.async("string")) as {
    sst?: { si?: unknown[] | unknown };
  };

  return toArray(shared.sst?.si).map((item) => extractText(item));
}

function extractText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractText(item)).join("");
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.t !== undefined) return extractText(record.t);
    if (record.r !== undefined) return extractText(record.r);
    if (record.is !== undefined) return extractText(record.is);
  }

  return "";
}

function columnIndex(cellReference: string): number {
  const letters = /^[A-Z]+/i.exec(cellReference)?.[0] ?? "";
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + letter.charCodeAt(0) - 64;
  }
  return index - 1;
}

function readCellValue(cell: Record<string, unknown>, sharedStrings: string[]): CellValue {
  const formula = cell.f !== undefined;
  const rawValue = cell.v;
  const type = cell.t;

  if (type === "s") {
    const index = Number(rawValue);
    return { formula, value: Number.isInteger(index) ? sharedStrings[index] ?? "" : "" };
  }

  if (type === "inlineStr") {
    return { formula, value: extractText(cell.is) };
  }

  if (rawValue === undefined) {
    return { formula, value: "" };
  }

  if (type === "str") {
    return { formula, value: String(rawValue) };
  }

  const numericValue = Number(rawValue);
  return {
    formula,
    value: Number.isFinite(numericValue) && String(rawValue).trim() !== "" ? numericValue : String(rawValue),
  };
}

async function readSheetRows(zip: JSZip, sheet: SheetDescriptor, sharedStrings: string[]): Promise<Array<Record<number, CellValue>>> {
  const worksheet = await parseXml<{
    worksheet?: { sheetData?: { row?: Array<Record<string, unknown>> | Record<string, unknown> } };
  }>(zip, sheet.path);

  const limits = getImportLimits();
  const rows = toArray(worksheet.worksheet?.sheetData?.row);
  if (rows.length - 1 > limits.maxRows) {
    throw new ImportValidationError("IMPORT_TOO_MANY_ROWS", "عدد الصفوف يتجاوز الحد المسموح", 422);
  }

  return rows.map((row) => {
    const cells: Record<number, CellValue> = {};
    for (const cell of toArray(row.c as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      const index = columnIndex(String(cell.r ?? ""));
      if (index >= limits.maxColumns) {
        throw new ImportValidationError("IMPORT_TOO_MANY_COLUMNS", "عدد الأعمدة يتجاوز الحد المسموح", 422);
      }
      cells[index] = readCellValue(cell, sharedStrings);
    }
    return cells;
  });
}

function rowHasData(row: Record<number, CellValue>): boolean {
  return Object.values(row).some((cell) => String(cell.value ?? "").trim() !== "");
}

async function chooseSheet(zip: JSZip, sheets: SheetDescriptor[]): Promise<SheetDescriptor> {
  const visibleSheets = sheets.filter((sheet) => sheet.visible);
  if (visibleSheets.length === 0) {
    throw new ImportValidationError("IMPORT_NO_VISIBLE_SHEETS", "لا توجد ورقة ظاهرة قابلة للقراءة", 422);
  }

  const namedSheet = visibleSheets.find((sheet) => sheet.name === "الشكاوى" || sheet.name === "Complaints");
  if (namedSheet) return namedSheet;

  const sharedStrings = await readSharedStrings(zip);
  const candidates: SheetDescriptor[] = [];
  for (const sheet of visibleSheets) {
    const rows = await readSheetRows(zip, sheet, sharedStrings);
    if (rows.some(rowHasData)) candidates.push(sheet);
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new ImportValidationError("IMPORT_EMPTY_WORKBOOK", "ملف Excel لا يحتوي بيانات قابلة للاستيراد", 422);
  }

  throw new ImportValidationError("IMPORT_AMBIGUOUS_SHEETS", "يوجد أكثر من ورقة بيانات محتملة", 422);
}

export async function parseXlsxWorkbook(buffer: Buffer): Promise<ParsedWorkbook> {
  const zip = await validateXlsxZip(buffer);
  const sheets = await readSheets(zip);
  const limits = getImportLimits();
  if (sheets.length > limits.maxSheets) {
    throw new ImportValidationError("IMPORT_TOO_MANY_SHEETS", "عدد أوراق Excel يتجاوز الحد المسموح", 422);
  }

  const sharedStrings = await readSharedStrings(zip);
  const selectedSheet = await chooseSheet(zip, sheets);
  const sheetRows = await readSheetRows(zip, selectedSheet, sharedStrings);
  const nonEmptyRows = sheetRows.filter(rowHasData);
  const headerRow = nonEmptyRows[0];

  if (!headerRow) {
    throw new ImportValidationError("IMPORT_EMPTY_WORKBOOK", "ملف Excel لا يحتوي صف عناوين", 422);
  }

  const headerIndexes = Object.keys(headerRow).map(Number).sort((left, right) => left - right);
  const headers = headerIndexes.map((index) => String(headerRow[index]?.value ?? "").trim());
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) {
    throw new ImportValidationError("DUPLICATE_IMPORT_COLUMN", "ملف Excel يحتوي عناوين أعمدة مكررة", 422);
  }

  const rows = nonEmptyRows.slice(1).map((row, offset) => {
    const values: Record<string, unknown> = {};
    for (const [position, header] of headers.entries()) {
      if (!header) continue;
      const cell = row[headerIndexes[position]];
      values[header] = cell?.formula ? `=${String(cell.value ?? "")}` : cell?.value ?? "";
    }
    return { rowNumber: offset + 2, values };
  });

  return {
    selectedSheet: selectedSheet.name,
    headers,
    rows,
    zip,
  };
}
