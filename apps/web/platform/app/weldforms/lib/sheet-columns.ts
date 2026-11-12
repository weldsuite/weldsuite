/**
 * The columns of a form's `form_responses` connected table in WeldSheets
 * (ADR SHEETS-007), as the platform builds them from a form definition. The key
 * scheme is the one of `@weldsuite/forms-domain/columns`, which sheets-api lists
 * with: a question is `qb` + its block id without the underscore, a hidden field
 * is `h` + its name. Sensitive, file and signature questions have no column.
 * Keys are saved in sheet definitions, so they never change.
 */

import { fieldsOf, isFileField, type FormDefinition } from '@weldsuite/forms-engine';
import { FORM_RESPONSE_DYNAMIC_COLUMN, MAX_SHEET_DATA_COLUMNS, defaultSheetDataColumns } from '@weldsuite/app-api-client/schemas/sheet-data';

export interface SheetFormColumn {
  key: string;
  /** The question's title, or the hidden field's name. */
  label: string;
  kind: 'answer' | 'hidden';
}

const BLOCK_ID = /^b_([A-Za-z0-9]+)$/;

/** The column key of a question, or null when its id is not of the builder's shape. */
export function questionColumnKey(blockId: string): string | null {
  const m = BLOCK_ID.exec(blockId);
  return m ? `qb${m[1]}` : null;
}

/** The question and hidden-field columns a form can add to its responses table, in form order. */
export function sheetFormColumns(definition: Pick<FormDefinition, 'blocks' | 'hidden'>): SheetFormColumn[] {
  const columns: SheetFormColumn[] = [];
  for (const field of fieldsOf(definition)) {
    const key = questionColumnKey(field.id);
    if (!key || field.sensitive || isFileField(field)) continue;
    columns.push({ key, label: field.title.trim() || key, kind: 'answer' });
  }
  for (const hidden of definition.hidden) {
    if (!/^[A-Za-z0-9]+$/.test(hidden.name)) continue;
    columns.push({ key: `h${hidden.name}`, label: hidden.name, kind: 'hidden' });
  }
  return columns.filter((c) => FORM_RESPONSE_DYNAMIC_COLUMN.test(c.key));
}

/**
 * The columns a new responses table starts with: the usual metadata fields
 * (number, submitted at, email), then every question (not the hidden fields).
 * `metaLabel` names a metadata field in the viewer's language.
 */
export function defaultFormResponseColumns(
  definition: Pick<FormDefinition, 'blocks' | 'hidden'>,
  metaLabel: (key: string) => string,
): { columns: string[]; headers: string[] } {
  const columns = defaultSheetDataColumns('form_responses').map((key) => ({ key, label: metaLabel(key) }));
  const questions = sheetFormColumns(definition).filter((c) => c.kind === 'answer');
  const all = [...columns, ...questions].slice(0, MAX_SHEET_DATA_COLUMNS);
  return { columns: all.map((c) => c.key), headers: all.map((c) => c.label.slice(0, 255)) };
}
