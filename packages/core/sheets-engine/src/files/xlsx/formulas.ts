/**
 * Formula text in .xlsx files. Excel stores formulas in the same canonical
 * syntax WeldSheets does (',' between arguments, '.' decimal, English
 * function names), except that functions added after Excel 2007 carry a
 * `_xlfn.` prefix (FILTER and SORT `_xlfn._xlws.`), so older readers show
 * #NAME? instead of misreading them. Reading drops the prefixes; writing
 * adds them back.
 */

import { tokenize, type Token } from '../../formula/lexer';
import { parseFormula } from '../../formula/parser';

/** Functions Excel writes as `_xlfn.NAME`. */
const FUTURE_FUNCTIONS = new Set([
  'ACOT', 'ACOTH', 'AGGREGATE', 'ARABIC', 'ARRAYTOTEXT', 'BASE', 'BETA.DIST', 'BETA.INV', 'BINOM.DIST',
  'BINOM.DIST.RANGE', 'BINOM.INV', 'BITAND', 'BITLSHIFT', 'BITOR', 'BITRSHIFT', 'BITXOR', 'BYCOL', 'BYROW',
  'CEILING.MATH', 'CEILING.PRECISE', 'CHISQ.DIST', 'CHISQ.DIST.RT', 'CHISQ.INV', 'CHISQ.INV.RT', 'CHISQ.TEST',
  'CHOOSECOLS', 'CHOOSEROWS', 'COMBINA', 'CONCAT', 'CONFIDENCE.NORM', 'CONFIDENCE.T', 'COT', 'COTH',
  'COVARIANCE.P', 'COVARIANCE.S', 'CSC', 'CSCH', 'DAYS', 'DECIMAL', 'DROP', 'ERF.PRECISE', 'ERFC.PRECISE',
  'EXPAND', 'EXPON.DIST', 'F.DIST', 'F.DIST.RT', 'F.INV', 'F.INV.RT', 'F.TEST', 'FILTERXML', 'FLOOR.MATH',
  'FLOOR.PRECISE', 'FORECAST.ETS', 'FORECAST.ETS.CONFINT', 'FORECAST.ETS.SEASONALITY', 'FORECAST.ETS.STAT',
  'FORECAST.LINEAR', 'FORMULATEXT', 'GAMMA', 'GAMMA.DIST', 'GAMMA.INV', 'GAMMALN.PRECISE', 'GAUSS', 'GROUPBY',
  'HSTACK', 'HYPGEOM.DIST', 'IFNA', 'IFS', 'IMAGE', 'IMCOSH', 'IMCOT', 'IMCSC', 'IMCSCH', 'IMSEC', 'IMSECH',
  'IMSINH', 'IMTAN', 'ISFORMULA', 'ISOMITTED', 'ISOWEEKNUM', 'LAMBDA', 'LET', 'LOGNORM.DIST', 'LOGNORM.INV',
  'MAKEARRAY', 'MAP', 'MAXIFS', 'MINIFS', 'MODE.MULT', 'MODE.SNGL', 'MUNIT', 'NEGBINOM.DIST',
  'NETWORKDAYS.INTL', 'NORM.DIST', 'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'NUMBERVALUE', 'PDURATION',
  'PERCENTILE.EXC', 'PERCENTILE.INC', 'PERCENTOF', 'PERCENTRANK.EXC', 'PERCENTRANK.INC', 'PERMUTATIONA',
  'PHI', 'PIVOTBY', 'POISSON.DIST', 'QUARTILE.EXC', 'QUARTILE.INC', 'RANDARRAY', 'RANK.AVG', 'RANK.EQ',
  'REDUCE', 'REGEXEXTRACT', 'REGEXREPLACE', 'REGEXTEST', 'RRI', 'SCAN', 'SEC', 'SECH', 'SEQUENCE', 'SHEET',
  'SHEETS', 'SKEW.P', 'SORTBY', 'STDEV.P', 'STDEV.S', 'SWITCH', 'T.DIST', 'T.DIST.2T', 'T.DIST.RT', 'T.INV',
  'T.INV.2T', 'T.TEST', 'TAKE', 'TEXTAFTER', 'TEXTBEFORE', 'TEXTJOIN', 'TEXTSPLIT', 'TOCOL', 'TOROW',
  'UNICHAR', 'UNICODE', 'UNIQUE', 'VALUETOTEXT', 'VAR.P', 'VAR.S', 'VSTACK', 'WEIBULL.DIST',
  'WORKDAY.INTL', 'WRAPCOLS', 'WRAPROWS', 'XLOOKUP', 'XMATCH', 'XOR', 'Z.TEST',
]);

/** Functions Excel writes as `_xlfn._xlws.NAME`. */
const WORKSHEET_FUNCTIONS = new Set(['FILTER', 'SORT']);

const PREFIX = /^(?:_xl(?:fn|ws|pm)\.)+/i;

/**
 * A formula from a file as WeldSheets formula text, or null when WeldSheets
 * cannot read it (table references, links to other workbooks, …): the cell
 * then keeps its last value.
 */
export function fromExcelFormula(text: string): string | null {
  let out = text.startsWith('=') ? text.slice(1) : text;
  if (/_xl(?:fn|ws|pm)\./i.test(out)) {
    let tokens: Token[];
    try {
      tokens = tokenize(out);
    } catch {
      return null;
    }
    out = splice(out, tokens, (t) => {
      if (t.type !== 'func' && t.type !== 'name') return null;
      const bare = t.value.replace(PREFIX, '');
      // `_xlfn.SINGLE(x)` is Excel's `@x` (implicit intersection); WeldSheets reads x.
      if (t.type === 'func' && bare.toUpperCase() === 'SINGLE') return '';
      return bare === t.value ? null : bare;
    });
  }
  try {
    parseFormula(out);
  } catch {
    return null;
  }
  return out;
}

/** WeldSheets formula text as Excel stores it. */
export function toExcelFormula(text: string): string {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    return text;
  }
  return splice(text, tokens, (t) => {
    if (t.type !== 'func') return null;
    if (WORKSHEET_FUNCTIONS.has(t.value)) return `_xlfn._xlws.${t.value}`;
    return FUTURE_FUNCTIONS.has(t.value) ? `_xlfn.${t.value}` : null;
  });
}

/** `text` with each token `replace` returns a string for swapped for that string. */
function splice(text: string, tokens: Token[], replace: (t: Token) => string | null): string {
  let out = '';
  let from = 0;
  for (const t of tokens) {
    const next = replace(t);
    if (next === null) continue;
    out += text.slice(from, t.start) + next;
    from = t.end;
  }
  return from === 0 ? text : out + text.slice(from);
}
