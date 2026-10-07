import * as XLSX from 'xlsx';
import { GridColumnDef } from '../types';
import { asText } from '@weldsuite/text';

/** Extra context export formatting needs that isn't on the column/entity itself. */
export interface ExportContext {
  /** Resolves a `member`-type column's stored userId to a display name. */
  memberNameById?: Record<string, string>;
}

/**
 * Column value → export cell string. Shared by CSV and Excel so both stay in
 * sync: a `member` column exports the member's name (never the raw user id),
 * and an array value (multi-select / tags) exports as a readable
 * semicolon-joined list instead of `JSON.stringify` (which rendered an empty
 * tag list as the literal text `[]`).
 */
function formatExportValue<TEntity>(
  col: GridColumnDef<TEntity>,
  entity: TEntity,
  context?: ExportContext,
): string {
  const value = col.getValue(entity);
  if (value === null || value === undefined || value === '') return '';

  if (col.type === 'member' && typeof value === 'string') {
    return context?.memberNameById?.[value] ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).join('; ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return asText(value);
}

// Export entities to CSV
export async function exportToCSV<TEntity>(
  entities: TEntity[],
  columns: GridColumnDef<TEntity>[],
  filename: string,
  context?: ExportContext,
): Promise<void> {
  const headers = columns.map((col) => col.name);
  const rows = entities.map((entity) =>
    columns.map((col) => formatExportValue(col, entity, context))
  );

  const csvContent = [
    headers.join(','),
    ...rows.map((row) =>
      row.map((cell) => {
        // Escape quotes and wrap in quotes if contains comma or newline
        if (cell.includes(',') || cell.includes('\n') || cell.includes('"')) {
          return `"${cell.replace(/"/g, '""')}"`;
        }
        return cell;
      }).join(',')
    ),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename);
}

// Export entities to Excel
export async function exportToExcel<TEntity>(
  entities: TEntity[],
  columns: GridColumnDef<TEntity>[],
  filename: string,
  sheetName: string = 'Data',
  context?: ExportContext,
): Promise<void> {
  const headers = columns.map((col) => col.name);
  const rows = entities.map((entity) =>
    columns.map((col) => formatExportValue(col, entity, context))
  );

  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  // Auto-size columns
  const maxWidth = 50;
  const colWidths = headers.map((header, i) => ({
    wch: Math.min(
      maxWidth,
      Math.max(
        header.length,
        ...rows.map((row) => asText(row[i] || '').length)
      )
    ),
  }));
  worksheet['!cols'] = colWidths;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

// Helper to download a blob
function downloadBlob(blob: Blob, filename: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}