import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { matchComplaintColumns, validateColumnMapping } from "./complaint-column-schema";
import { validateXlsxZip } from "./file-storage";
import { normalizeExcelSerialDate, normalizeImportRow } from "./normalization";
import { parseXlsxWorkbook } from "./xlsx-parser";

async function workbookBuffer(options: {
  sheets?: Array<{ name: string; rows: string[][]; state?: string }>;
  extra?: Record<string, string>;
} = {}): Promise<Buffer> {
  const zip = new JSZip();
  const sheets = options.sheets ?? [
    {
      name: "الشكاوى",
      rows: [
        ["رقم الشكوى", "تاريخ الشكوى", "الموضوع", "الحالة"],
        ["C-1", "2026-07-01", "نص عربي", "مفتوح"],
      ],
    },
  ];

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ""}/>`).join("")}
  </sheets>
</workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}
</Relationships>`);

  for (const [sheetIndex, sheet] of sheets.entries()) {
    zip.file(`xl/worksheets/sheet${sheetIndex + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<worksheet><sheetData>
${sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">
${row.map((value, columnIndex) => {
  const column = String.fromCharCode(65 + columnIndex);
  return `<c r="${column}${rowIndex + 1}" t="inlineStr"><is><t>${value}</t></is></c>`;
}).join("")}
</row>`).join("")}
</sheetData></worksheet>`);
  }

  for (const [name, content] of Object.entries(options.extra ?? {})) {
    zip.file(name, content);
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

describe("secure xlsx import parsing", () => {
  it("parses a valid Arabic complaint workbook", async () => {
    const parsed = await parseXlsxWorkbook(await workbookBuffer());

    expect(parsed.selectedSheet).toBe("الشكاوى");
    expect(parsed.headers).toEqual(["رقم الشكوى", "تاريخ الشكوى", "الموضوع", "الحالة"]);
    expect(parsed.rows[0]).toMatchObject({
      rowNumber: 2,
      values: {
        "رقم الشكوى": "C-1",
        "الموضوع": "نص عربي",
      },
    });
  });

  it("rejects zip slip entries", async () => {
    const buffer = await workbookBuffer({ extra: { "../evil.txt": "bad" } });

    await expect(validateXlsxZip(buffer)).rejects.toMatchObject({
      code: "IMPORT_ZIP_SLIP_DETECTED",
    });
  });

  it("rejects active workbook content", async () => {
    const buffer = await workbookBuffer({ extra: { "xl/vbaProject.bin": "macro" } });

    await expect(validateXlsxZip(buffer)).rejects.toMatchObject({
      code: "IMPORT_XLSX_ACTIVE_CONTENT",
    });
  });

  it("rejects ambiguous visible data sheets", async () => {
    const buffer = await workbookBuffer({
      sheets: [
        { name: "A", rows: [["رقم الشكوى"], ["C-1"]] },
        { name: "B", rows: [["رقم الشكوى"], ["C-2"]] },
      ],
    });

    await expect(parseXlsxWorkbook(buffer)).rejects.toMatchObject({
      code: "IMPORT_AMBIGUOUS_SHEETS",
    });
  });

  it("keeps formulas as unsafe values for row validation", () => {
    const mapping = matchComplaintColumns(["رقم الشكوى", "تاريخ الشكوى", "الموضوع"]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ الشكوى": "2026-07-01",
          "الموضوع": "=HYPERLINK(\"http://example.test\")",
        },
      },
      mapping
    );

    expect(result.errors).toContainEqual(expect.objectContaining({ code: "FORMULA_NOT_ALLOWED" }));
  });

  it("normalizes Excel serial dates without relying on locale timezone", () => {
    expect(normalizeExcelSerialDate(45108)?.toISOString()).toBe("2023-07-01T00:00:00.000Z");
  });

  it("validates required mapped columns", () => {
    const mapping = matchComplaintColumns(["رقم الشكوى", "الموضوع"]);

    expect(() => validateColumnMapping(mapping)).toThrow(/تاريخ/);
  });

  it("parses a generated 5000-row workbook within the configured row limit", async () => {
    const rows = [
      ["رقم الشكوى", "تاريخ الشكوى", "الموضوع"],
      ...Array.from({ length: 5_000 }, (_, index) => [
        `C-${index + 1}`,
        "2026-07-01",
        `شكوى صناعية ${index + 1}`,
      ]),
    ];
    const startedAt = performance.now();
    const parsed = await parseXlsxWorkbook(await workbookBuffer({
      sheets: [{ name: "الشكاوى", rows }],
    }));
    const durationMs = performance.now() - startedAt;

    expect(parsed.rows).toHaveLength(5_000);
    expect(durationMs).toBeLessThan(5_000);
  }, 10_000);
});
