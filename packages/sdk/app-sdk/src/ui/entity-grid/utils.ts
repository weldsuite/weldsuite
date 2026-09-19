import type { GridColumnDef, GridSortConfig } from './types';

export function stringifyCellValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stringifyCellValue).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function filterEntities<TEntity>(
  entities: TEntity[],
  columns: GridColumnDef<TEntity>[],
  search: string,
): TEntity[] {
  const q = search.trim().toLowerCase();
  if (!q) return entities;
  return entities.filter((entity) =>
    columns.some((col) => {
      if (col.visible === false) return false;
      return stringifyCellValue(col.getValue(entity)).toLowerCase().includes(q);
    }),
  );
}

export function sortEntities<TEntity>(
  entities: TEntity[],
  columns: GridColumnDef<TEntity>[],
  sort: GridSortConfig,
): TEntity[] {
  if (!sort.field || !sort.direction) return entities;
  const column = columns.find((c) => c.id === sort.field);
  if (!column) return entities;
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...entities].sort((a, b) => {
    const av = column.getValue(a);
    const bv = column.getValue(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return stringifyCellValue(av).localeCompare(stringifyCellValue(bv), undefined, {
      sensitivity: 'base',
      numeric: true,
    }) * dir;
  });
}

export function exportEntitiesCsv<TEntity>(
  entities: TEntity[],
  columns: GridColumnDef<TEntity>[],
  filename: string,
): void {
  const visible = columns.filter((c) => c.visible !== false);
  const header = visible.map((c) => csvEscape(c.name)).join(',');
  const rows = entities.map((entity) =>
    visible.map((c) => csvEscape(stringifyCellValue(c.getValue(entity)))).join(','),
  );
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function formatDisplayValue(type: string, value: unknown): string {
  if (value == null || value === '') return '';
  if (type === 'checkbox') return value ? '✓' : '';
  if (type === 'currency' && typeof value === 'number') return value.toFixed(2);
  if (type === 'percent' && typeof value === 'number') return `${value}%`;
  if (type === 'date') {
    const d = value instanceof Date ? value : new Date(String(value));
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
  }
  if (type === 'multi-select' && Array.isArray(value)) return value.join(', ');
  return stringifyCellValue(value);
}
