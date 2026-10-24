import {
  collectRefs,
  delocalizeFormula,
  formatA1,
  functionNames,
  quoteSheetName,
  type FormulaLocale,
  type Range,
} from '@weldsuite/sheets-engine';

/** A formula reference found in the edit text, with the range it targets on the current sheet. */
export interface EditRef {
  range: Range;
  /** Index into REFERENCE_COLORS, stable per distinct reference text. */
  colorIndex: number;
}

export function isFormulaText(text: string): boolean {
  return text.startsWith('=') && text.length > 0;
}

/** References in a formula being typed that point at `sheetName` (unprefixed ones included). */
export function refsInEdit(text: string, sheetName: string, locale: FormulaLocale): EditRef[] {
  if (!isFormulaText(text)) return [];
  const refs = collectRefs(delocalizeFormula(text.slice(1), locale));
  const seen = new Map<string, number>();
  const out: EditRef[] = [];
  for (const ref of refs) {
    if (ref.sheet !== null && ref.sheet.toLowerCase() !== sheetName.toLowerCase()) continue;
    const key = `${ref.r1}:${ref.c1}:${ref.r2}:${ref.c2}`;
    if (!seen.has(key)) seen.set(key, seen.size);
    out.push({ range: { r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 }, colorIndex: seen.get(key)! });
  }
  return out;
}

const REF_ACCEPTING = new Set(['=', '(', ',', ';', '+', '-', '*', '/', '^', '&', '<', '>', ':', ' ']);

/**
 * Whether clicking a cell should insert its reference at `caret` ("point
 * mode"): the text is a formula and the caret follows an operator, a comma or
 * an opening parenthesis.
 */
export function acceptsReference(text: string, caret: number): boolean {
  if (!isFormulaText(text) || caret < 1) return false;
  const before = text.slice(0, caret).trimEnd();
  const last = before[before.length - 1];
  return last !== undefined && REF_ACCEPTING.has(last);
}

/** A1 text for a range as typed into a formula, sheet-qualified when it is on another sheet. */
export function referenceText(range: Range, targetSheet: string, editingSheet: string): string {
  const a = formatA1(range.r1, range.c1);
  const body = range.r1 === range.r2 && range.c1 === range.c2 ? a : `${a}:${formatA1(range.r2, range.c2)}`;
  return targetSheet === editingSheet ? body : `${quoteSheetName(targetSheet)}!${body}`;
}

/** The identifier being typed at the caret, when it could be a function name. */
export function functionPrefixAt(text: string, caret: number): { start: number; prefix: string } | null {
  if (!isFormulaText(text)) return null;
  let start = caret;
  while (start > 1 && /[A-Za-z0-9_.]/.test(text[start - 1]!)) start--;
  const prefix = text.slice(start, caret);
  if (!prefix || !/^[A-Za-z]/.test(prefix)) return null;
  const before = text.slice(0, start).trimEnd();
  if (!REF_ACCEPTING.has(before[before.length - 1] ?? '')) return null;
  return { start, prefix };
}

export function suggestFunctions(prefix: string, limit = 8): string[] {
  const upper = prefix.toUpperCase();
  return functionNames()
    .filter((n) => n.startsWith(upper))
    .slice(0, limit);
}
