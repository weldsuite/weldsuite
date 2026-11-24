import type { LineProblem } from '@weldsuite/commerce-sdk';
import type { ProblemRow } from '../../actions';

/** Quick-order and reorder lines to show the shopper. */
export function problemRows(problems: LineProblem[]): ProblemRow[] {
  return problems.map((problem, position) => ({
    id: `${problem.row ?? 'r'}:${problem.sku ?? problem.productId ?? ''}:${position}`,
    row: problem.row,
    sku: problem.sku,
    message: problem.message,
    added: problem.problem === 'OUT_OF_STOCK',
  }));
}

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);

/**
 * "SKU quantity", "SKU;quantity" and tab-separated lines (pasted from a
 * spreadsheet) as the API's "SKU,quantity": the first `;` or tab becomes a
 * comma, or else the last run of spaces, whichever comes first.
 */
export function toCsvLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.includes(',')) return trimmed;
  const separators = [trimmed.indexOf(';'), trimmed.indexOf('\t')].filter((at) => at >= 0);
  const separator = separators.length > 0 ? Math.min(...separators) : -1;
  let runEnd = trimmed.length - 1;
  while (runEnd >= 0 && !isSpace(trimmed[runEnd])) runEnd -= 1;
  let runStart = runEnd;
  while (runStart > 0 && isSpace(trimmed[runStart - 1])) runStart -= 1;
  if (separator >= 0 && (runEnd < 0 || separator <= runStart)) {
    return `${trimmed.slice(0, separator)},${trimmed.slice(separator + 1)}`;
  }
  if (runEnd >= 0) return `${trimmed.slice(0, runStart)},${trimmed.slice(runEnd + 1)}`;
  return trimmed;
}
