import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { US_STATES } from '@/components/address/us-states';
import { useUpdateForm1099Line } from '@/hooks/queries/use-weldbooks-1099-queries';
import type { Form1099Filing, Form1099FilingLine } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { form1099ReportBoxes } from '@/lib/weldbooks/form-1099';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { boxEntries, boxTag } from '../../../form-1099-model';
import {
  buildLinePatch,
  initialLineEditorValues,
  isEmptyPatch,
  type LineEditorProblem,
  type LineEditorValues,
} from '../line-patch';

interface LineEditorDialogProps {
  filing: Pick<Form1099Filing, 'id' | 'formType' | 'status'>;
  line: Form1099FilingLine | null;
  onOpenChange: (open: boolean) => void;
}

const NO_STATE = '__none__';

export function LineEditorDialog({ filing, line, onOpenChange }: Readonly<LineEditorDialogProps>) {
  const { t } = useI18n();
  const tl = t.weldbooksUs.form1099.lineEditor;
  const { formatMoney } = useWeldbooksFormat();
  const update = useUpdateForm1099Line(filing.id);
  const [values, setValues] = useState<LineEditorValues | null>(null);
  const [problems, setProblems] = useState<LineEditorProblem[]>([]);

  useEffect(() => {
    setValues(line ? initialLineEditorValues(line) : null);
    setProblems([]);
  }, [line]);

  if (!line || !values) return null;

  const pendingCorrection = filing.status === 'corrected' && line.pendingCorrection;
  const boxes = form1099ReportBoxes(filing.formType);
  const patch = <K extends keyof LineEditorValues>(key: K, value: LineEditorValues[K]) => setValues({ ...values, [key]: value });

  const problemOf = <F extends LineEditorProblem['field']>(field: F) =>
    problems.find((p): p is Extract<LineEditorProblem, { field: F }> => p.field === field);

  const setAdjustment = (index: number, change: Partial<LineEditorValues['adjustments'][number]>) =>
    patch('adjustments', values.adjustments.map((row, i) => (i === index ? { ...row, ...change } : row)));

  const save = async () => {
    const result = buildLinePatch(line, values, { pendingCorrection });
    if (!result.ok) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    if (isEmptyPatch(result.patch)) {
      onOpenChange(false);
      return;
    }
    try {
      await update.mutateAsync({ lineId: line.id, patch: result.patch });
      toast.success(tl.saved);
      onOpenChange(false);
    } catch (err) {
      toast.error(tl.failed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const recipient = line.recipient?.name ?? line.partyName ?? '';

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tl.title.replace('{name}', recipient)}</DialogTitle>
          <DialogDescription>{pendingCorrection ? tl.descriptionCorrection : tl.description}</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {pendingCorrection ? (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">{tl.boxesTitle}</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {boxes.map((box) => {
                  const bad = problems.some((p) => p.field === 'box' && p.code === box.code);
                  return (
                    <div key={box.code} className="space-y-1">
                      <Label htmlFor={`box-${box.code}`} className="text-xs">
                        {box.number}. {box.label}
                      </Label>
                      <Input
                        id={`box-${box.code}`}
                        inputMode="decimal"
                        className="text-right tabular-nums"
                        value={values.boxes[box.code] ?? ''}
                        aria-invalid={bad}
                        onChange={(event) => patch('boxes', { ...values.boxes, [box.code]: event.target.value })}
                      />
                      {bad ? <p className="text-xs text-destructive">{tl.problems.amount}</p> : null}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ) : (
            <>
              <section aria-labelledby="line-books" className="space-y-1">
                <h3 id="line-books" className="text-sm font-medium">
                  {tl.fromBooks}
                </h3>
                {boxEntries(line.boxes).length === 0 ? (
                  <p className="text-sm text-muted-foreground">{tl.noAmounts}</p>
                ) : (
                  <ul className="text-sm">
                    {boxEntries(line.boxes).map((entry) => (
                      <li key={entry.code} className="flex justify-between gap-3 tabular-nums">
                        <span className="text-muted-foreground">{boxTag(entry.code)}</span>
                        <span>{formatMoney(entry.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">{tl.fromBooksHelp}</p>
              </section>

              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">{tl.adjustmentsTitle}</legend>
                <p className="text-xs text-muted-foreground">{tl.adjustmentsHelp}</p>
                {values.adjustments.map((row, index) => {
                  const found = problems.find((p) => p.field === 'adjustment' && p.index === index) as
                    | Extract<LineEditorProblem, { field: 'adjustment' }>
                    | undefined;
                  return (
                    <div key={index} className="grid grid-cols-1 gap-2 rounded-md border p-3 sm:grid-cols-[1fr_8rem_2fr_auto]" data-testid="adjustment-row">
                      <div className="space-y-1">
                        <Label htmlFor={`adj-box-${index}`} className="text-xs">
                          {tl.adjustmentBox}
                        </Label>
                        <Select value={row.box || NO_STATE} onValueChange={(value) => setAdjustment(index, { box: value === NO_STATE ? '' : value })}>
                          <SelectTrigger id={`adj-box-${index}`} aria-invalid={found?.problem === 'box'}>
                            <SelectValue placeholder={tl.chooseBox} />
                          </SelectTrigger>
                          <SelectContent>
                            {boxes.map((box) => (
                              <SelectItem key={box.code} value={box.code}>
                                {box.number}. {box.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`adj-amount-${index}`} className="text-xs">
                          {tl.adjustmentAmount}
                        </Label>
                        <Input
                          id={`adj-amount-${index}`}
                          inputMode="decimal"
                          className="text-right tabular-nums"
                          placeholder="-125.00"
                          value={row.amount}
                          aria-invalid={found?.problem === 'amount' || found?.problem === 'zero'}
                          onChange={(event) => setAdjustment(index, { amount: event.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`adj-reason-${index}`} className="text-xs">
                          {tl.adjustmentReason}
                        </Label>
                        <Input
                          id={`adj-reason-${index}`}
                          maxLength={255}
                          value={row.reason}
                          aria-invalid={found?.problem === 'reason'}
                          onChange={(event) => setAdjustment(index, { reason: event.target.value })}
                        />
                      </div>
                      <div className="flex items-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={tl.removeAdjustment}
                          onClick={() => patch('adjustments', values.adjustments.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </Button>
                      </div>
                      {found ? (
                        <p className="text-xs text-destructive sm:col-span-4" role="alert">
                          {tl.problems[found.problem]}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => patch('adjustments', [...values.adjustments, { box: boxes[0]?.code ?? '', amount: '', reason: '' }])}
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden />
                  {tl.addAdjustment}
                </Button>
              </fieldset>
            </>
          )}

          <section className="space-y-2">
            <label className="flex items-start gap-2 text-sm" htmlFor="line-excluded">
              <Checkbox id="line-excluded" checked={values.excluded} onCheckedChange={(checked) => patch('excluded', checked === true)} />
              <span>
                <span className="font-medium">{pendingCorrection ? tl.withdraw : tl.exclude}</span>
                <span className="block text-xs text-muted-foreground">{pendingCorrection ? tl.withdrawHelp : tl.excludeHelp}</span>
              </span>
            </label>
            {values.excluded ? (
              <div className="space-y-1">
                <Label htmlFor="line-excluded-reason">{tl.excludeReason} *</Label>
                <Input
                  id="line-excluded-reason"
                  maxLength={255}
                  value={values.excludedReason}
                  aria-invalid={Boolean(problemOf('excludedReason'))}
                  onChange={(event) => patch('excludedReason', event.target.value)}
                />
                {problemOf('excludedReason') ? <p className="text-xs text-destructive">{tl.problems.reason}</p> : null}
              </div>
            ) : null}
          </section>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{tl.stateTitle}</legend>
            {line.stateHint?.needsDirectFiling ? (
              <p className="text-xs text-amber-600 dark:text-amber-400" role="note">
                {tl.stateDirect.replace('{state}', line.stateHint.state)}
                {line.stateHint.note ? ` ${line.stateHint.note}` : ''}
              </p>
            ) : line.stateHint ? (
              <p className="text-xs text-muted-foreground">{tl.stateCfsf.replace('{state}', line.stateHint.state)}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{tl.stateHelp}</p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="line-state">{tl.stateCode}</Label>
                <Select value={values.stateCode || NO_STATE} onValueChange={(value) => patch('stateCode', value === NO_STATE ? '' : value)}>
                  <SelectTrigger id="line-state">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_STATE}>{tl.noState}</SelectItem>
                    {US_STATES.map((state) => (
                      <SelectItem key={state.code} value={state.code}>
                        {state.code} · {state.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="line-state-id">{tl.stateId}</Label>
                <Input id="line-state-id" maxLength={50} autoComplete="off" value={values.stateIdNumber} onChange={(event) => patch('stateIdNumber', event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="line-state-income">{tl.stateIncome}</Label>
                <Input
                  id="line-state-income"
                  inputMode="decimal"
                  className="text-right tabular-nums"
                  value={values.stateIncome}
                  aria-invalid={Boolean(problemOf('stateIncome'))}
                  onChange={(event) => patch('stateIncome', event.target.value)}
                />
                {problemOf('stateIncome') ? <p className="text-xs text-destructive">{tl.problems.amount}</p> : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="line-state-withheld">{tl.stateWithheld}</Label>
                <Input
                  id="line-state-withheld"
                  inputMode="decimal"
                  className="text-right tabular-nums"
                  value={values.stateWithheld}
                  aria-invalid={Boolean(problemOf('stateWithheld'))}
                  onChange={(event) => patch('stateWithheld', event.target.value)}
                />
                {problemOf('stateWithheld') ? <p className="text-xs text-destructive">{tl.problems.amount}</p> : null}
              </div>
            </div>
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tl.cancel}
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
              {tl.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
