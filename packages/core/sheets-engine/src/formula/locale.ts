/**
 * Formula separators per locale.
 *
 * Formulas are stored canonically: ',' between arguments, '.' as the decimal
 * point, '{1,2;3,4}' for arrays. In locales with a decimal comma (nl, de, fr,
 * …) people type ';' between arguments, ',' as the decimal point and
 * '{1\2;3\4}' for arrays, as Google Sheets does there. Function names stay
 * English in every locale.
 */

export interface FormulaLocale {
  decimal: '.' | ',';
}

export const CANONICAL_FORMULA_LOCALE: FormulaLocale = { decimal: '.' };

/** Canonical formula text → what a user of `locale` sees and edits. */
export function localizeFormula(formula: string, locale: FormulaLocale): string {
  if (locale.decimal === '.') return formula;
  return mapOutsideLiterals(formula, (ch, inArray) => {
    if (ch === ',') return inArray ? '\\' : ';';
    if (ch === '.') return ',';
    return ch;
  });
}

/** What a user of `locale` typed → canonical formula text. */
export function delocalizeFormula(text: string, locale: FormulaLocale): string {
  if (locale.decimal === '.') return text;
  return mapOutsideLiterals(text, (ch, inArray) => {
    if (ch === ';') return inArray ? ';' : ',';
    if (ch === '\\' && inArray) return ',';
    if (ch === ',') return '.';
    return ch;
  });
}

/**
 * Maps characters outside string literals and quoted sheet names. '.' is only
 * passed to `fn` between digits (a decimal point, not part of a name such as
 * STDEV.P or Sheet.1).
 */
function mapOutsideLiterals(src: string, fn: (ch: string, inArray: boolean) => string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === ch) {
          if (src[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === '.' && !(/\d/.test(src[i - 1] ?? '') && /\d/.test(src[i + 1] ?? '') && !inIdentifier(src, i))) {
      out += ch;
      continue;
    }
    out += fn(ch, depth > 0);
  }
  return out;
}

/** True when the digits before `i` belong to a name or reference (A1.5 is not a number). */
function inIdentifier(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\d/.test(src[j]!)) j--;
  return j >= 0 && /[A-Za-z_$]/.test(src[j]!);
}
