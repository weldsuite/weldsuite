import type { CellFormat, CellValue } from './types';

const FORMAT_PREFIX = '__fmt__';
const NOTE_PREFIX = '__note__';
const LINK_PREFIX = '__link__';

export function formatKey(colId: string): string {
  return FORMAT_PREFIX + colId;
}

export function isFormatKey(key: string): boolean {
  return key.startsWith(FORMAT_PREFIX);
}

// Per-cell note (a plain string shown on hover with a corner marker).
export function noteKey(colId: string): string {
  return NOTE_PREFIX + colId;
}

export function getCellNote(rowData: Record<string, unknown> | undefined, colId: string): string | undefined {
  const v = rowData?.[noteKey(colId)];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Per-cell hyperlink (a URL the cell text links to).
export function linkKey(colId: string): string {
  return LINK_PREFIX + colId;
}

export function getCellLink(rowData: Record<string, unknown> | undefined, colId: string): string | undefined {
  const v = rowData?.[linkKey(colId)];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function getCellFormat(rowData: Record<string, unknown> | undefined, colId: string): CellFormat | undefined {
  if (!rowData) return undefined;
  const fmt = rowData[formatKey(colId)];
  return fmt && typeof fmt === 'object' ? fmt as CellFormat : undefined;
}

export function getCellStyle(format: CellFormat | undefined): React.CSSProperties {
  if (!format) return {};
  const style: React.CSSProperties & { '--cell-rotation'?: string } = {};
  if (format.bold) style.fontWeight = 'bold';
  if (format.italic) style.fontStyle = 'italic';
  if (format.strikethrough) style.textDecoration = 'line-through';
  if (format.textColor) style.color = format.textColor;
  if (format.fillColor) style.backgroundColor = format.fillColor;
  if (format.fontFamily) style.fontFamily = format.fontFamily;
  if (format.fontSize) style.fontSize = `${format.fontSize}px`;
  if (format.textAlign) style.textAlign = format.textAlign;
  // Vertical align
  if (format.verticalAlign) {
    switch (format.verticalAlign) {
      case 'top': style.alignItems = 'flex-start'; break;
      case 'middle': style.alignItems = 'center'; break;
      case 'bottom': style.alignItems = 'flex-end'; break;
    }
    style.display = 'flex';
  }
  // Text wrapping
  if (format.textWrap) {
    switch (format.textWrap) {
      case 'wrap': style.whiteSpace = 'pre-wrap'; style.wordBreak = 'break-word'; break;
      case 'clip': style.whiteSpace = 'nowrap'; style.overflow = 'hidden'; style.textOverflow = 'clip'; break;
      case 'overflow': style.whiteSpace = 'nowrap'; style.overflow = 'visible'; break;
    }
  }
  // Text rotation — use writing-mode for vertical, and a rotated inner span approach for angles
  if (format.textRotation) {
    const deg = format.textRotation;
    if (deg === 90) {
      // Vertical upward: text reads bottom-to-top
      style.writingMode = 'vertical-rl';
      style.transform = 'rotate(180deg)';
    } else if (deg === -90) {
      // Vertical downward: text reads top-to-bottom
      style.writingMode = 'vertical-rl';
    } else {
      // Tilted text (e.g. 45° or -45°): rotate the content in-place
      // The cell needs to be tall enough — handled by row height
      style.display = 'flex';
      style.alignItems = 'flex-end';
      style.overflow = 'visible';
      // Use a CSS custom property so the cell renderer can apply rotation to inner text
      style['--cell-rotation'] = `${deg}deg`;
    }
  }
  // Borders
  if (format.border && format.border !== 'none') {
    const b = '1px solid #000';
    switch (format.border) {
      case 'all': style.border = b; break;
      case 'outer': style.border = b; break;
      case 'top': style.borderTop = b; break;
      case 'bottom': style.borderBottom = b; break;
      case 'left': style.borderLeft = b; break;
      case 'right': style.borderRight = b; break;
    }
  }
  return style;
}

export function detectCellType(value: string): 'number' | 'date' | 'text' {
  if (value === '') return 'text';
  // Check if it's a number
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return 'number';
  // Check common date patterns (ISO, MM/DD/YYYY, DD-MM-YYYY)
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(value)) return 'date';
  return 'text';
}

export function getDefaultAlign(value: string, format?: CellFormat): 'left' | 'right' | 'center' {
  if (format?.textAlign) return format.textAlign;
  const type = detectCellType(value);
  return type === 'number' || type === 'date' ? 'right' : 'left';
}

export function formatCellDisplay(rawValue: CellValue | undefined, format?: CellFormat): string {
  if (rawValue === null || rawValue === undefined) return '';
  const str = String(rawValue);
  if (!format?.numberFormat || format.numberFormat === 'general') return str;

  const num = Number(rawValue);
  if (isNaN(num)) return str;

  const decimals = format.decimalPlaces ?? 2;

  switch (format.numberFormat) {
    case 'number':
      return num.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    case 'currency': {
      const symbol = format.currencySymbol ?? '$';
      const formatted = Math.abs(num).toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      return num < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
    }
    case 'percent':
      return (num * 100).toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }) + '%';
    case 'date': {
      const d = new Date(num);
      if (isNaN(d.getTime())) return str;
      return d.toLocaleDateString();
    }
    case 'time': {
      const d = new Date(num);
      if (isNaN(d.getTime())) return str;
      return d.toLocaleTimeString();
    }
    case 'scientific':
      return num.toExponential(decimals);
    case 'auto':
    case 'text':
    default:
      return str;
  }
}

export function mergeFormat(existing: CellFormat | undefined, update: Partial<CellFormat>): CellFormat {
  return { ...existing, ...update };
}

export function toggleFormatBool(existing: CellFormat | undefined, key: 'bold' | 'italic' | 'strikethrough'): CellFormat {
  return { ...existing, [key]: !existing?.[key] };
}
