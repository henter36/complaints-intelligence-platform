const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

export function parseExcelSerialDate(value: number): Date | null {
  if (!Number.isFinite(value) || value <= 0 || value > 2_958_465) {
    return null;
  }

  const milliseconds = Math.round(value * 86_400_000);
  const date = new Date(EXCEL_EPOCH + milliseconds);

  return Number.isNaN(date.getTime()) ? null : date;
}
