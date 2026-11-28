/**
 * "Ask for receipts": one question about each of the bank lines picked in
 * Missing receipts (`POST /api/accounting-questions/bulk`, edition feature
 * `books-questions`). The answer is a summary: how many lines were asked
 * about, and which could not be, with the reason.
 */

import { useEffect, useId, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useAskQuestionsBulk } from '@/hooks/queries/use-weldbooks-questions-queries';
import { getLocale } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { useI18n } from '@/lib/i18n/provider';

const MAX_TEXT = 10_000;

interface ReceiptValues {
  text: string;
}

export function AskReceiptsDialog({
  open,
  onOpenChange,
  lineIds,
  lineName,
  onDone,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The bank lines to ask about (the server takes up to 100). */
  lineIds: readonly string[];
  /** What a line is called in the result ("J. Bakker"). */
  lineName: (lineId: string) => string;
  /** The questions were sent: the caller clears its selection. */
  onDone?: () => void;
}>) {
  const { t } = useI18n();
  const tr = t.weldbooksQuestions.receipts;
  const ta = t.weldbooksQuestions.ask;
  const ask = useAskQuestionsBulk();
  const textId = useId();

  const schema = useMemo(
    () => z.object({ text: z.string().trim().min(1, ta.textRequired).max(MAX_TEXT, ta.textTooLong) }),
    [ta],
  );
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ReceiptValues>({ resolver: zodResolver(schema), defaultValues: { text: tr.defaultText } });

  // Every opening starts from the default question and no result.
  useEffect(() => {
    if (open) {
      reset({ text: tr.defaultText });
      ask.reset();
    }
    // `ask` changes identity with its state: only the opening resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reset, tr.defaultText]);

  const submit = handleSubmit((values) => {
    ask.mutate(
      { recordType: 'bank_transaction', recordIds: [...lineIds], text: values.text.trim() },
      { onSuccess: () => onDone?.() },
    );
  });

  const result = ask.data;
  const locale = getLocale();
  const textError = errors.text?.message;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{result ? tr.resultTitle : tr.dialogTitle}</DialogTitle>
          <DialogDescription>
            {result ? null : plural(lineIds.length, tr.dialogDescription, locale)}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3" role="status" data-testid="receipts-result">
            <p className="text-sm">{plural(result.created.length, tr.resultCreated, locale)}</p>
            {result.failed.length > 0 ? (
              <div className="space-y-1.5" data-testid="receipts-failed">
                <p className="text-sm font-medium text-destructive">{plural(result.failed.length, tr.resultFailed, locale)}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                  {result.failed.map((failure) => (
                    <li key={failure.recordId}>
                      {tr.failedRow.replace('{line}', lineName(failure.recordId)).replace('{error}', failure.error)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {tr.close}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor={textId}>{ta.textLabel}</Label>
              <Textarea
                id={textId}
                rows={4}
                maxLength={MAX_TEXT}
                aria-invalid={textError ? true : undefined}
                aria-describedby={textError ? `${textId}-error` : undefined}
                {...register('text')}
              />
              {textError ? (
                <p id={`${textId}-error`} className="text-sm text-destructive" role="alert">
                  {textError}
                </p>
              ) : null}
            </div>
            {ask.isError ? (
              <p className="text-sm text-destructive" role="alert" data-testid="receipts-error">
                {(ask.error instanceof Error && ask.error.message) || tr.failed}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {tr.cancel}
              </Button>
              <Button type="submit" disabled={ask.isPending || lineIds.length === 0} data-testid="receipts-submit">
                {ask.isPending ? ta.sending : tr.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
