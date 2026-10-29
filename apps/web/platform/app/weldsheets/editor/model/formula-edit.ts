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

const IDENTIFIER = /[A-Za-z0-9_.]/;

/** The identifier being typed at the caret, when it could be a function name. */
export function functionPrefixAt(text: string, caret: number): { start: number; prefix: string } | null {
  if (!isFormulaText(text)) return null;
  let start = caret;
  while (start > 1 && IDENTIFIER.test(text[start - 1]!)) start--;
  const prefix = text.slice(start, caret);
  if (!prefix || !/^[A-Za-z]/.test(prefix)) return null;
  const before = text.slice(0, start).trimEnd();
  if (!REF_ACCEPTING.has(before[before.length - 1] ?? '')) return null;
  return { start, prefix };
}

/** Something formula autocomplete offers for the name being typed. */
export interface FormulaSuggestion {
  kind: 'function' | 'name';
  name: string;
}

export interface SuggestionMatch {
  /** The identifier being replaced: from `start` to `end` (past the caret when typing inside a word). */
  start: number;
  end: number;
  prefix: string;
  /** The identifier is also a cell reference (`G10`): Enter keeps it as typed, only Tab takes a suggestion. */
  reference: boolean;
  items: FormulaSuggestion[];
}

/** Letters then digits, as a cell reference is typed (`G10`, `ab2`). */
const CELL_REFERENCE = /^[A-Za-z]{1,3}\d+$/;

/**
 * Functions and defined names for the identifier at the caret, as Excel lists
 * them: the ones that start with it first, then the ones that contain it
 * ("LOOKUP" → HLOOKUP, VLOOKUP, XLOOKUP). Nothing once the identifier is the
 * only match and typed in full. A cell reference lists only names that start
 * with it: `G10` is not a hint at LOG10.
 */
export function formulaSuggestions(text: string, caret: number, definedNames: readonly string[] = [], limit = 50): SuggestionMatch | null {
  const at = functionPrefixAt(text, caret);
  if (!at) return null;
  let end = caret;
  while (end < text.length && IDENTIFIER.test(text[end]!)) end++;
  const reference = CELL_REFERENCE.test(at.prefix);
  const upper = at.prefix.toUpperCase();
  const all: FormulaSuggestion[] = [
    ...functionNames().map((name) => ({ kind: 'function' as const, name })),
    ...definedNames.map((name) => ({ kind: 'name' as const, name })),
  ];
  const key = (s: FormulaSuggestion) => s.name.toUpperCase();
  const byName = (a: FormulaSuggestion, b: FormulaSuggestion) => {
    if (key(a) === key(b)) return 0;
    return key(a) < key(b) ? -1 : 1;
  };
  const starting = all.filter((s) => key(s).startsWith(upper)).sort(byName);
  const containing = reference ? [] : all.filter((s) => !key(s).startsWith(upper) && key(s).includes(upper)).sort(byName);
  const items = [...starting, ...containing].slice(0, limit);
  const complete = items.length === 1 && key(items[0]!) === upper;
  return { start: at.start, end, prefix: at.prefix, reference, items: complete ? [] : items };
}

/** The edit text with a suggestion put in place of the identifier: a function gets its opening parenthesis. */
export function applySuggestion(text: string, match: SuggestionMatch, item: FormulaSuggestion): { text: string; caret: number } {
  const before = text.slice(0, match.start);
  const after = text.slice(match.end);
  if (item.kind === 'name') return { text: before + item.name + after, caret: match.start + item.name.length };
  const paren = after.startsWith('(') ? '' : '(';
  return { text: `${before}${item.name}${paren}${after}`, caret: match.start + item.name.length + 1 };
}

/** A function call the caret is in: the function's name, where it starts, and the argument being typed (0-based). */
export interface CallAt {
  name: string;
  start: number;
  argIndex: number;
}

/**
 * The innermost function call around the caret, for the argument hint.
 * String literals, quoted sheet names and array constants are skipped;
 * arguments are counted by the locale's separator (";" where the decimal
 * point is a comma).
 */
export function callAt(text: string, caret: number, locale: FormulaLocale): CallAt | null {
  if (!isFormulaText(text)) return null;
  const separator = locale.decimal === ',' ? ';' : ',';
  const calls: { name: string | null; start: number; argIndex: number }[] = [];
  let braces = 0;
  let i = 1;
  while (i < caret) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") i = closingQuote(text, i);
    else if (ch === '{') braces++;
    else if (ch === '}') braces = Math.max(0, braces - 1);
    else if (ch === '(') calls.push(callFrame(text, i));
    else if (ch === ')') calls.pop();
    else if (ch === separator && braces === 0 && calls.length) calls[calls.length - 1]!.argIndex++;
    i++;
  }
  for (let k = calls.length - 1; k >= 0; k--) {
    const call = calls[k]!;
    if (call.name) return { name: call.name, start: call.start, argIndex: call.argIndex };
  }
  return null;
}

/** An opening parenthesis: a call when a function name is right before it, a grouping otherwise. */
function callFrame(text: string, paren: number): { name: string | null; start: number; argIndex: number } {
  let start = paren;
  while (start > 1 && IDENTIFIER.test(text[start - 1]!)) start--;
  const name = text.slice(start, paren);
  return { name: /^[A-Za-z]/.test(name) ? name.toUpperCase() : null, start, argIndex: 0 };
}

/** Index of the quote closing the literal opened at `open` (doubled quotes are escapes), or the end of the text. */
function closingQuote(text: string, open: number): number {
  const q = text[open];
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] !== q) continue;
    if (text[i + 1] === q) i++;
    else return i;
  }
  return text.length;
}

/**
 * A function's argument list from its help (`"number1, [number2], …"`) laid
 * out for the argument being typed: past the listed arguments, the repeating
 * group at the end is spelled out with its numbers counted up, as Excel does
 * (`SUM(number1, [number2], [number3], …)`). `active` is -1 when the function
 * takes no argument at that position.
 */
export function signatureTokens(args: string, argIndex: number): { tokens: string[]; active: number } {
  const listed = splitArgs(args);
  const repeats = listed[listed.length - 1] === '…';
  const named = repeats ? listed.slice(0, -1) : listed;
  if (!repeats || argIndex < named.length || named.length === 0) {
    return { tokens: listed, active: argIndex < named.length ? argIndex : -1 };
  }
  let groupStart = named.length - 1;
  for (let i = named.length - 1; i >= 0; i--) {
    if (named[i]!.startsWith('[')) {
      groupStart = i;
      break;
    }
  }
  const group = named.slice(groupStart);
  const tokens = [...named];
  let round = 0;
  while (tokens.length <= argIndex) {
    round++;
    const step = round;
    tokens.push(...group.map((t) => t.replace(/\d+/, (n) => String(Number(n) + step))));
  }
  return { tokens: [...tokens, '…'], active: argIndex };
}

/** How many arguments a help argument list requires and takes in all; `repeats` when it ends in "…". */
export function argumentCounts(args: string): { required: number; total: number; repeats: boolean } {
  const listed = splitArgs(args);
  const repeats = listed[listed.length - 1] === '…';
  const named = repeats ? listed.slice(0, -1) : listed;
  let required = 0;
  let optional = false;
  for (const token of named) {
    if (token.startsWith('[')) optional = true;
    if (!optional) required++;
    if (token.endsWith(']')) optional = false;
  }
  return { required, total: named.length, repeats };
}

function splitArgs(args: string): string[] {
  return args ? args.split(', ') : [];
}
