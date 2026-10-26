/** Headers for files the sheet routes hand out. */

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const CONTENT_TYPES = {
  xlsx: XLSX_TYPE,
  csv: 'text/csv; charset=utf-8',
} as const;

/** `attachment` with an ASCII fallback name and the real one (RFC 6266). */
export function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
