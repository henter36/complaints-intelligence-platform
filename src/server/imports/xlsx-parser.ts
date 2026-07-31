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

type ParsedWorksheet = {
  worksheet?: { sheetData?: { row?: Array<Record<string, unknown>> | Record<string, unknown> } };
};

type WorksheetCache = Map<string, ParsedWorksheet>;

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
    sst?: { si?: unknown };
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

function cellValueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return "";
}

function columnIndex(cellReference: string): number {
  const letters = /^[A-Z]+/i.exec(cellReference)?.[0] ?? "";
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    const codePoint = letter.codePointAt(0);
    if (codePoint === undefined) return -1;
    index = index * 26 + codePoint - 64;
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
    return { formula, value: cellValueToText(rawValue) };
  }

  const numericValue = Number(rawValue);
  const textValue = cellValueToText(rawValue);
  return {
    formula,
    value: Number.isFinite(numericValue) && textValue.trim() !== "" ? numericValue : textValue,
  };
}

async function readParsedWorksheet(
  zip: JSZip,
  sheet: SheetDescriptor,
  cache: WorksheetCache
): Promise<ParsedWorksheet> {
  const cached = cache.get(sheet.path);
  if (cached) return cached;

  const worksheet = await parseXml<ParsedWorksheet>(zip, sheet.path);
  cache.set(sheet.path, worksheet);
  return worksheet;
}

function readSheetRowsFromWorksheet(
  worksheet: ParsedWorksheet,
  sharedStrings: string[],
  enforceLimits: boolean
): Array<Record<number, CellValue>> {
  const limits = getImportLimits();
  const rows = toArray(worksheet.worksheet?.sheetData?.row);

  return rows.map((row) => {
    const cells: Record<number, CellValue> = {};
    for (const cell of toArray(row.c as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      const index = columnIndex(cellValueToText(cell.r));
      if (enforceLimits && index >= limits.maxColumns) {
        throw new ImportValidationError("IMPORT_TOO_MANY_COLUMNS", "عدد الأعمدة يتجاوز الحد المسموح", 422);
      }
      if (index < 0) continue;
      cells[index] = readCellValue(cell, sharedStrings);
    }
    return cells;
  });
}

function rowHasData(row: Record<number, CellValue>): boolean {
  return Object.values(row).some((cell) => cellValueToText(cell.value).trim() !== "");
}

async function probeSheet(
  zip: JSZip,
  sheet: SheetDescriptor,
  sharedStrings: string[],
  cache: WorksheetCache
): Promise<boolean> {
  const worksheet = await readParsedWorksheet(zip, sheet, cache);
  return readSheetRowsFromWorksheet(worksheet, sharedStrings, false).some(rowHasData);
}

async function chooseSheet(
  zip: JSZip,
  sheets: SheetDescriptor[],
  sharedStrings: string[],
  cache: WorksheetCache
): Promise<SheetDescriptor> {
  const visibleSheets = sheets.filter((sheet) => sheet.visible);
  if (visibleSheets.length === 0) {
    throw new ImportValidationError("IMPORT_NO_VISIBLE_SHEETS", "لا توجد ورقة ظاهرة قابلة للقراءة", 422);
  }

  const namedSheet = visibleSheets.find((sheet) => sheet.name === "الشكاوى" || sheet.name === "Complaints");
  if (namedSheet) return namedSheet;

  const candidates: SheetDescriptor[] = [];
  for (const sheet of visibleSheets) {
    if (await probeSheet(zip, sheet, sharedStrings, cache)) candidates.push(sheet);
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
  const worksheetCache: WorksheetCache = new Map();
  const limits = getImportLimits();
  if (sheets.length > limits.maxSheets) {
    throw new ImportValidationError("IMPORT_TOO_MANY_SHEETS", "عدد أوراق Excel يتجاوز الحد المسموح", 422);
  }

  const sharedStrings = await readSharedStrings(zip);
  const selectedSheet = await chooseSheet(zip, sheets, sharedStrings, worksheetCache);
  const selectedWorksheet = await readParsedWorksheet(zip, selectedSheet, worksheetCache);
  const sheetRows = readSheetRowsFromWorksheet(selectedWorksheet, sharedStrings, true);
  const nonEmptyRows = sheetRows.filter(rowHasData);
  const headerRow = nonEmptyRows[0];

  if (!headerRow) {
    throw new ImportValidationError("IMPORT_EMPTY_WORKBOOK", "ملف Excel لا يحتوي صف عناوين", 422);
  }

  const dataRowCount = nonEmptyRows.length - 1;
  if (dataRowCount > limits.maxRows) {
    throw new ImportValidationError("IMPORT_TOO_MANY_ROWS", "عدد الصفوف يتجاوز الحد المسموح", 422);
  }

  const headerIndexes = Object.keys(headerRow).map(Number).sort((left, right) => left - right);
  const headers = headerIndexes.map((index) => cellValueToText(headerRow[index]?.value).trim());
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) {
    throw new ImportValidationError("DUPLICATE_IMPORT_COLUMN", "ملف Excel يحتوي عناوين أعمدة مكررة", 422);
  }

  const rows = nonEmptyRows.slice(1).map((row, offset) => {
    const values: Record<string, unknown> = {};
    for (const [position, header] of headers.entries()) {
      if (!header) continue;
      const cell = row[headerIndexes[position]];
      values[header] = cell?.formula ? `=${cellValueToText(cell.value)}` : cell?.value ?? "";
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
