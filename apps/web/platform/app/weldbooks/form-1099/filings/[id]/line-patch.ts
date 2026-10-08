/**
 * What the line editor sends: the body of `PATCH /form-1099/filings/:id/lines/:lineId`
 * built from the editor's fields, with only what changed, and the problems
 * found before anything is sent.
 *
 * On a draft or reviewed filing a line takes manual adjustments (each with a
 * reason), an include/exclude decision (excluding needs a reason) and its
 * state fields. A correction that has not been filed yet takes its boxes
 * directly instead of adjustments.
 */
import type { Form1099FilingLine, LinePatch } from '@/lib/api/domains/weldbooks-1099';
import {
  boxesDiffer,
  checkAdjustmentDrafts,
  draftsFromLine,
  parseAmountInput,
  parseBoxInputs,
  type AdjustmentDraft,
  type AdjustmentProblem,
} from '../../form-1099-model';

export interface LineEditorValues {
  adjustments: AdjustmentDraft[];
  /** Leave the recipient off the form. */
  excluded: boolean;
  excludedReason: string;
  stateCode: string;
  stateIdNumber: string;
  stateIncome: string;
  stateWithheld: string;
  /** The boxes of a pending correction, as typed. */
  boxes: Record<string, string>;
}

export type LineEditorProblem =
  | { field: 'adjustment'; index: number; problem: AdjustmentProblem }
  | { field: 'excludedReason' }
  | { field: 'stateIncome' }
  | { field: 'stateWithheld' }
  | { field: 'box'; code: string };

export function initialLineEditorValues(line: Form1099FilingLine): LineEditorValues {
  const boxes: Record<string, string> = {};
  for (const [code, amount] of Object.entries(line.boxes)) boxes[code] = String(amount);
  return {
    adjustments: draftsFromLine(line),
    excluded: line.status === 'excluded',
    excludedReason: line.status === 'excluded' ? line.excludedReason ?? '' : '',
    stateCode: line.stateCode ?? '',
    stateIdNumber: line.stateIdNumber ?? '',
    stateIncome: line.stateIncome ?? '',
    stateWithheld: line.stateWithheld ?? '',
    boxes,
  };
}

export type LinePatchResult = { ok: true; patch: LinePatch } | { ok: false; problems: LineEditorProblem[] };

const sameAmount = (a: string | null, b: string) => (a === null || a === '' ? b.trim() === '' : parseAmountInput(b) === Number(a));

/** The patch for what changed in the editor; `patch` is empty when nothing did. */
export function buildLinePatch(
  line: Form1099FilingLine,
  values: LineEditorValues,
  options: { pendingCorrection: boolean },
): LinePatchResult {
  const problems: LineEditorProblem[] = [];
  const patch: LinePatch = {};
  const initial = initialLineEditorValues(line);

  // State fields (both kinds of edit).
  const stateCode = values.stateCode.trim().toUpperCase();
  if (stateCode !== (line.stateCode ?? '')) patch.stateCode = stateCode || null;
  if (values.stateIdNumber.trim() !== (line.stateIdNumber ?? '')) patch.stateIdNumber = values.stateIdNumber.trim() || null;
  if (!sameAmount(line.stateIncome, values.stateIncome)) {
    const amount = values.stateIncome.trim() ? parseAmountInput(values.stateIncome) : null;
    if (values.stateIncome.trim() && amount === null) problems.push({ field: 'stateIncome' });
    else patch.stateIncome = amount;
  }
  if (!sameAmount(line.stateWithheld, values.stateWithheld)) {
    const amount = values.stateWithheld.trim() ? parseAmountInput(values.stateWithheld) : null;
    if (values.stateWithheld.trim() && amount === null) problems.push({ field: 'stateWithheld' });
    else patch.stateWithheld = amount;
  }

  if (options.pendingCorrection) {
    const { boxes, invalid } = parseBoxInputs(values.boxes);
    for (const code of invalid) problems.push({ field: 'box', code });
    if (invalid.length === 0 && boxesDiffer(boxes, line.boxes)) patch.boxes = boxes;
    // Withdrawing a correction needs a reason, like excluding a recipient.
    if (values.excluded && !initial.excluded) {
      if (!values.excludedReason.trim()) problems.push({ field: 'excludedReason' });
      else {
        patch.status = 'excluded';
        patch.excludedReason = values.excludedReason.trim();
      }
    }
  } else {
    const check = checkAdjustmentDrafts(values.adjustments);
    for (const found of check.problems) problems.push({ field: 'adjustment', index: found.index, problem: found.problem });
    if (check.problems.length === 0 && JSON.stringify(check.adjustments) !== JSON.stringify(
      (line.adjustments ?? []).map((a) => ({ box: a.box, amount: a.amount, reason: a.reason })),
    )) {
      patch.adjustments = check.adjustments;
    }

    if (values.excluded) {
      const reason = values.excludedReason.trim();
      if (!reason) problems.push({ field: 'excludedReason' });
      else if (!initial.excluded || reason !== initial.excludedReason) {
        patch.status = 'excluded';
        patch.excludedReason = reason;
      }
    } else if (initial.excluded) {
      patch.status = 'included';
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, patch };
}

export function isEmptyPatch(patch: LinePatch): boolean {
  return Object.keys(patch).length === 0;
}
