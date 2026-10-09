import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
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
import { useCorrectForm1099Line } from '@/hooks/queries/use-weldbooks-1099-queries';
import type { Form1099Filing, Form1099FilingLine } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { form1099ReportBoxes } from '@/lib/weldbooks/form-1099';
import { boxesDiffer, parseBoxInputs } from '../../../form-1099-model';

interface CorrectionDialogProps {
  filing: Pick<Form1099Filing, 'id' | 'formType'>;
  line: Form1099FilingLine | null;
  onOpenChange: (open: boolean) => void;
}

type Problem = 'amount' | 'unchanged' | 'reason' | null;

/**
 * Corrects a recipient on a filed form: the new amounts per box and why. This
 * adds a corrected line next to the original, which stays as filed, and puts
 * the filing back to "corrected" until the correction is filed too.
 */
export function CorrectionDialog({ filing, line, onOpenChange }: Readonly<CorrectionDialogProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.form1099.correction;
  const correct = useCorrectForm1099Line(filing.id);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [refreshRecipient, setRefreshRecipient] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [badBoxes, setBadBoxes] = useState<string[]>([]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const [code, amount] of Object.entries(line?.boxes ?? {})) next[code] = String(amount);
    setInputs(next);
    setReason('');
    setRefreshRecipient(false);
    setProblem(null);
    setBadBoxes([]);
  }, [line]);

  if (!line) return null;
  const boxes = form1099ReportBoxes(filing.formType);

  const submit = async () => {
    const { boxes: parsed, invalid } = parseBoxInputs(inputs);
    setBadBoxes(invalid);
    if (invalid.length > 0) return setProblem('amount');
    if (!reason.trim()) return setProblem('reason');
    if (!refreshRecipient && !boxesDiffer(parsed, line.boxes)) return setProblem('unchanged');
    setProblem(null);
    try {
      await correct.mutateAsync({ lineId: line.id, correction: { boxes: parsed, reason: reason.trim(), refreshRecipient: refreshRecipient || undefined } });
      toast.success(tc.done);
      onOpenChange(false);
    } catch (err) {
      toast.error(tc.failed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tc.title.replace('{name}', line.recipient?.name ?? line.partyName ?? '')}</DialogTitle>
          <DialogDescription>{tc.description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{tc.boxesTitle}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {boxes.map((box) => (
                <div key={box.code} className="space-y-1">
                  <Label htmlFor={`correct-${box.code}`} className="text-xs">
                    {box.number}. {box.label}
                  </Label>
                  <Input
                    id={`correct-${box.code}`}
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    value={inputs[box.code] ?? ''}
                    aria-invalid={badBoxes.includes(box.code)}
                    onChange={(event) => setInputs({ ...inputs, [box.code]: event.target.value })}
                  />
                </div>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1">
            <Label htmlFor="correct-reason">{tc.reason} *</Label>
            <Input
              id="correct-reason"
              maxLength={255}
              value={reason}
              aria-invalid={problem === 'reason'}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          <label className="flex items-start gap-2 text-sm" htmlFor="correct-refresh">
            <Checkbox id="correct-refresh" checked={refreshRecipient} onCheckedChange={(checked) => setRefreshRecipient(checked === true)} />
            <span>
              <span className="font-medium">{tc.refreshRecipient}</span>
              <span className="block text-xs text-muted-foreground">{tc.refreshRecipientHelp}</span>
            </span>
          </label>

          {problem ? (
            <p className="text-sm text-destructive" role="alert">
              {tc.problems[problem]}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tc.cancel}
            </Button>
            <Button type="submit" disabled={correct.isPending}>
              {correct.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
              {tc.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
