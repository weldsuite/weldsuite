/** What reading a spreadsheet file gives, and how it can fail. */

import type { ZipLimits } from '@weldsuite/zip-xml';
import type { FormatLocale } from '../format/number-format';
import type { WorkbookSnapshot } from '../model/workbook';

/**
 * Parts of a file WeldSheets could not bring over. The workbook is still
 * read; these say what is missing from it.
 */
export type ImportWarning =
  /** Formulas WeldSheets cannot read (table references, links to other files): their last values were kept. */
  | 'formulas'
  /** Conditional formats of a kind WeldSheets does not have (data bars, icon sets, top 10, …). */
  | 'conditionalFormats'
  | 'validations'
  /** Filter criteria WeldSheets does not have (dates by group, top 10, colours). */
  | 'filters'
  /** Charts, pictures and shapes. */
  | 'drawings'
  | 'comments'
  | 'pivotTables'
  /** Excel tables (their cells are read as plain cells). */
  | 'tables'
  /** Sheets that hold only a chart. */
  | 'chartSheets'
  | 'macros'
  | 'externalLinks'
  /** Text formatted in parts within a cell (it keeps the cell's own format). */
  | 'richText';

export interface ImportResult {
  workbook: WorkbookSnapshot;
  warnings: ImportWarning[];
}

export type ImportErrorCode = 'not_spreadsheet' | 'too_large' | 'corrupt' | 'unsupported' | 'empty';

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: ImportErrorCode,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ReadOptions {
  /** How dates and numbers are shown and typed (built-in date formats, CSV parsing). */
  locale?: FormatLocale;
  /** Most cells to read; a file with more is refused (`too_large`). */
  maxCells?: number;
  /** Id for the n-th sheet read (default `sheet1`, `sheet2`, …). */
  sheetId?: (index: number) => string;
}

export interface ReadXlsxOptions extends ReadOptions {
  limits?: ZipLimits;
}
