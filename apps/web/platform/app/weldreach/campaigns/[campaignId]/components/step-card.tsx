/** One step of the sequence: delay, subject, body and the threading choice. */

import { useRef } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { z } from 'zod';
import type { replaceReachStepsSchema } from '@weldsuite/app-api-client/schemas/reach';
import { cn } from '@/lib/utils';
import { insertAtSelection, unknownVariables } from '../../lib/sequence';
import { VariableMenu } from './variable-menu';

export type SequenceValues = z.infer<typeof replaceReachStepsSchema>;

type Field = 'subject' | 'body';

export function StepCard({
  form,
  index,
  total,
  selected,
  disabled,
  customFields,
  onSelect,
  onMove,
  onRemove,
}: Readonly<{
  form: UseFormReturn<SequenceValues>;
  index: number;
  total: number;
  selected: boolean;
  disabled: boolean;
  customFields: string[];
  onSelect: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}>) {
  const t = useTranslations();
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFocused = useRef<Field>('body');

  const { errors } = form.formState;
  const stepErrors = errors.steps?.[index];
  const isFirst = index === 0;

  const subject = form.register(`steps.${index}.subject`);
  const body = form.register(`steps.${index}.body`);
  const delayDays = form.register(`steps.${index}.delayDays`, { valueAsNumber: true });
  const delayHours = form.register(`steps.${index}.delayHours`, { valueAsNumber: true });

  const subjectText = form.watch(`steps.${index}.subject`);
  const bodyText = form.watch(`steps.${index}.body`);
  const unknown = unknownVariables([subjectText ?? '', bodyText ?? ''], customFields);
  const replyInThread = form.watch(`steps.${index}.replyInThread`);

  function insertVariable(token: string) {
    const field = lastFocused.current;
    const element = field === 'subject' ? subjectRef.current : bodyRef.current;
    const path = `steps.${index}.${field}` as const;
    const current = form.getValues(path) ?? '';
    const start = element?.selectionStart ?? current.length;
    const end = element?.selectionEnd ?? current.length;
    const next = insertAtSelection(current, start, end, token);

    form.setValue(path, next.value, { shouldDirty: true, shouldValidate: true });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  return (
    <Card
      onFocusCapture={onSelect}
      className={cn('gap-4 p-4', selected && 'border-foreground/30 ring-1 ring-foreground/10')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">
            {index + 1}
          </span>
          <h3 className="text-sm font-semibold">
            {isFirst
              ? t('reachEngage.sequence.firstEmail')
              : t('reachEngage.sequence.followUp', { number: index })}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
            aria-label={t('reachEngage.sequence.moveUp')}
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={disabled || index === total - 1}
            onClick={() => onMove(1)}
            aria-label={t('reachEngage.sequence.moveDown')}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            disabled={disabled || total <= 1}
            onClick={onRemove}
            aria-label={t('reachEngage.sequence.removeStep')}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {isFirst ? (
        <p className="text-xs text-muted-foreground">{t('reachEngage.sequence.firstEmailHint')}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <span className="pb-2 text-sm text-muted-foreground">
            {t('reachEngage.sequence.waitPrefix')}
          </span>
          <div className="space-y-1">
            <Label htmlFor={`step-${index}-days`} className="text-xs text-muted-foreground">
              {t('reachEngage.sequence.days')}
            </Label>
            <Input
              id={`step-${index}-days`}
              type="number"
              inputMode="numeric"
              min={0}
              max={90}
              className="h-8 w-20"
              aria-invalid={Boolean(stepErrors?.delayDays)}
              {...delayDays}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`step-${index}-hours`} className="text-xs text-muted-foreground">
              {t('reachEngage.sequence.hours')}
            </Label>
            <Input
              id={`step-${index}-hours`}
              type="number"
              inputMode="numeric"
              min={0}
              max={23}
              className="h-8 w-20"
              aria-invalid={Boolean(stepErrors?.delayHours)}
              {...delayHours}
            />
          </div>
          <span className="pb-2 text-sm text-muted-foreground">
            {t('reachEngage.sequence.waitSuffix')}
          </span>
          {(stepErrors?.delayDays || stepErrors?.delayHours) && (
            <p className="basis-full text-xs text-destructive">
              {t('reachEngage.sequence.delayInvalid')}
            </p>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={`step-${index}-subject`}>{t('reachEngage.sequence.subject')}</Label>
        <Input
          id={`step-${index}-subject`}
          autoComplete="off"
          placeholder={t('reachEngage.sequence.subjectPlaceholder')}
          aria-invalid={Boolean(stepErrors?.subject)}
          {...subject}
          ref={(element) => {
            subject.ref(element);
            subjectRef.current = element;
          }}
          onFocus={() => {
            lastFocused.current = 'subject';
          }}
        />
        {stepErrors?.subject && (
          <p className="text-xs text-destructive">{t('reachEngage.sequence.subjectRequired')}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor={`step-${index}-body`}>{t('reachEngage.sequence.body')}</Label>
          <VariableMenu customFields={customFields} disabled={disabled} onInsert={insertVariable} />
        </div>
        <Textarea
          id={`step-${index}-body`}
          rows={8}
          placeholder={t('reachEngage.sequence.bodyPlaceholder')}
          aria-invalid={Boolean(stepErrors?.body)}
          className="font-sans"
          {...body}
          ref={(element) => {
            body.ref(element);
            bodyRef.current = element;
          }}
          onFocus={() => {
            lastFocused.current = 'body';
          }}
        />
        {stepErrors?.body && (
          <p className="text-xs text-destructive">{t('reachEngage.sequence.bodyRequired')}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t('reachEngage.sequence.fallbackHelp', { example: '{{firstName|there}}' })}
        </p>
        {unknown.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t('reachEngage.sequence.unknownVariables', {
              names: unknown.map((name) => `{{${name}}}`).join(', '),
            })}
          </p>
        )}
      </div>

      {!isFirst && (
        <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2">
          <div className="space-y-0.5">
            <Label htmlFor={`step-${index}-thread`} className="text-sm">
              {t('reachEngage.sequence.replyInThread')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('reachEngage.sequence.replyInThreadHint')}
            </p>
          </div>
          <Switch
            id={`step-${index}-thread`}
            checked={replyInThread}
            disabled={disabled}
            onCheckedChange={(checked) =>
              form.setValue(`steps.${index}.replyInThread`, checked, { shouldDirty: true })
            }
          />
        </div>
      )}
    </Card>
  );
}
