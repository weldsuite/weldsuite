import * as XLSX from 'xlsx';
import { GridColumnDef } from '../types';

// Export entities to CSV
export async function exportToCSV<TEntity>(
  entities: TEntity[],
  columns: GridColumnDef<TEntity>[],
  filename: string
): Promise<void> {
  const headers = columns.map((col) => col.name);
  const rows = entities.map((entity) =>
    columns.map((col) => {
      const value = col.getValue(entity);
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    })
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
  sheetName: string = 'Data'
): Promise<void> {
  const headers = columns.map((col) => col.name);
  const rows = entities.map((entity) =>
    columns.map((col) => {
      const value = col.getValue(entity);
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return value;
    })
  );

  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  // Auto-size columns
  const maxWidth = 50;
  const colWidths = headers.map((header, i) => ({
    wch: Math.min(
      maxWidth,
      Math.max(
        header.length,
        ...rows.map((row) => String(row[i] || '').length)
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

// Parse CSV file
async function parseCSV(file: File): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const lines = text.split('\n').filter((line) => line.trim());
        if (lines.length === 0) {
          resolve([]);
          return;
        }

        const headers = parseCSVLine(lines[0]);
        const rows = lines.slice(1).map((line) => {
          const values = parseCSVLine(line);
          const row: Record<string, string> = {};
          headers.forEach((header, i) => {
            row[header] = values[i] || '';
          });
          return row;
        });

        resolve(rows);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// Parse a single CSV line (handles quoted fields)
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

// Parse Excel file
async function parseExcel(file: File): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, string>>(firstSheet, {
          raw: false,
          defval: '',
        });
        resolve(rows);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}
