/**
 * "Ask your accountant": a small form that puts a question on a WeldBooks
 * record: the text, and who should answer. By default the question goes to the
 * accountants (the server asks everyone who can book and can open the record);
 * "Choose people" lists the workspace members instead. It calls
 * `POST /api/accounting-questions` (edition feature `books-questions`).
 */

import { useEffect, useId, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import type { BooksRecordChatType } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
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
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useAskQuestion } from '@/hooks/queries/use-weldbooks-questions-queries';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import type { AskedQuestion } from '@/lib/api/domains/weldbooks-questions';
import { useI18n } from '@/lib/i18n/provider';

/** The longest question the server takes. */
const MAX_TEXT = 10_000;

type Who = 'accountants' | 'choose';

interface AskValues {
  text: string;
  who: Who;
  askedTo: string[];
}

export interface AskQuestionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recordType: BooksRecordChatType;
  recordId: string;
  /** The text the form starts with ("What was this payment?"). */
  defaultText?: string;
  onAsked?: (question: AskedQuestion) => void;
}

interface Member {
  userId: string;
  name: string;
}

/** The members a question can be asked to, by name. */
function useAskableMembers(enabled: boolean): Member[] {
  const { data } = useWorkspaceMembers();
  return useMemo(() => {
    if (!enabled) return [];
    const rows: Array<{ userId?: string; name?: string }> = data?.data ?? [];
    const seen = new Set<string>();
    const out: Member[] = [];
    for (const row of rows) {
      if (!row.userId || !row.name || seen.has(row.userId)) continue;
      seen.add(row.userId);
      out.push({ userId: row.userId, name: row.name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [data, enabled]);
}

export function AskQuestionDialog({
  open,
  onOpenChange,
  recordType,
  recordId,
  defaultText = '',
  onAsked,
}: Readonly<AskQuestionDialogProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksQuestions.ask;
  const record = t.weldbooksQuestions.records[recordType];
  const ask = useAskQuestion();
  const members = useAskableMembers(open);
  const ids = { text: useId(), error: useId(), who: useId() };

  const schema = useMemo(
    () =>
      z
        .object({
          text: z.string().trim().min(1, ta.textRequired).max(MAX_TEXT, ta.textTooLong),
          who: z.enum(['accountants', 'choose']),
          askedTo: z.array(z.string()),
        })
        .refine((values) => values.who === 'accountants' || values.askedTo.length > 0, {
          message: ta.whoNobody,
          path: ['askedTo'],
        }),
    [ta],
  );

  const defaults = useMemo<AskValues>(() => ({ text: defaultText, who: 'accountants', askedTo: [] }), [defaultText]);
  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setFocus,
    formState: { errors },
  } = useForm<AskValues>({ resolver: zodResolver(schema), defaultValues: defaults });

  // Every opening starts from the default text and the accountants.
  useEffect(() => {
    if (open) {
      reset(defaults);
      ask.reset();
    }
    // `ask` changes identity with its state: only the opening resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaults, reset]);

  const who = watch('who');

  const submit = handleSubmit(
    (values) => {
      ask.mutate(
        {
          recordType,
          recordId,
          text: values.text.trim(),
          askedTo: values.who === 'choose' ? values.askedTo : undefined,
        },
        {
          onSuccess: (question) => {
            toast.success(ta.sent);
            onAsked?.(question);
            onOpenChange(false);
          },
        },
      );
    },
    // The first field that failed takes the focus.
    (invalid) => {
      if (invalid.text) setFocus('text');
    },
  );

  const textError = errors.text?.message;
  const whoError = errors.askedTo?.message;
  const failure = ask.isError ? ((ask.error instanceof Error && ask.error.message) || ta.failed) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{ta.title}</DialogTitle>
          <DialogDescription>{ta.description.replace('{record}', record)}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor={ids.text}>{ta.textLabel}</Label>
            <Textarea
              id={ids.text}
              rows={4}
              maxLength={MAX_TEXT}
              placeholder={ta.textPlaceholder}
              aria-invalid={textError ? true : undefined}
              aria-describedby={textError ? `${ids.text}-error` : undefined}
              {...register('text')}
            />
            {textError ? (
              <p id={`${ids.text}-error`} className="text-sm text-destructive" role="alert">
                {textError}
              </p>
            ) : null}
          </div>

          <fieldset className="space-y-2" aria-describedby={whoError ? `${ids.who}-error` : undefined}>
            <legend className="mb-1 text-sm font-medium">{ta.whoLegend}</legend>
            <Controller
              control={control}
              name="who"
              render={({ field }) => (
                <div className="space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name={field.name}
                      className="mt-1 accent-primary"
                      checked={field.value === 'accountants'}
                      onChange={() => field.onChange('accountants')}
                    />
                    <span className="flex flex-col">
                      <span className="font-medium">{ta.whoAccountants}</span>
                      <span className="text-xs text-muted-foreground">{ta.whoAccountantsHint.replace('{record}', record)}</span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name={field.name}
                      className="mt-1 accent-primary"
                      checked={field.value === 'choose'}
                      onChange={() => field.onChange('choose')}
                    />
                    <span className="flex flex-col">
                      <span className="font-medium">{ta.whoChoose}</span>
                      <span className="text-xs text-muted-foreground">{ta.whoChooseHint}</span>
                    </span>
                  </label>
                </div>
              )}
            />

            {who === 'choose' ? (
              <Controller
                control={control}
                name="askedTo"
                render={({ field }) => (
                  <ul className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2" data-testid="ask-members">
                    {members.length === 0 ? (
                      <li className="text-sm text-muted-foreground">{ta.whoNoMembers}</li>
                    ) : (
                      members.map((member) => {
                        const checkboxId = `${ids.who}-${member.userId}`;
                        const checked = field.value.includes(member.userId);
                        return (
                          <li key={member.userId} className="flex items-center gap-2 text-sm">
                            <Checkbox
                              id={checkboxId}
                              checked={checked}
                              onCheckedChange={(next) =>
                                field.onChange(
                                  next === true
                                    ? [...field.value, member.userId]
                                    : field.value.filter((id) => id !== member.userId),
                                )
                              }
                            />
                            <Label htmlFor={checkboxId} className="cursor-pointer font-normal">
                              {member.name}
                            </Label>
                          </li>
                        );
                      })
                    )}
                  </ul>
                )}
              />
            ) : null}
            {whoError ? (
              <p id={`${ids.who}-error`} className="text-sm text-destructive" role="alert">
                {whoError}
              </p>
            ) : null}
          </fieldset>

          {failure ? (
            <p id={ids.error} className="text-sm text-destructive" role="alert" data-testid="ask-error">
              {failure}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {ta.cancel}
            </Button>
            <Button type="submit" disabled={ask.isPending} data-testid="ask-submit">
              {ask.isPending ? ta.sending : ta.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
