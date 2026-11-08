/**
 * The panel beside the sequence canvas for one step, laid out like WeldConnect's
 * step panel: the wait before it, subject, body and threading, its live preview,
 * and Move / Delete at the bottom.
 */

import { useRef } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  EditorPanelBody,
  EditorPanelFooter,
  EditorPanelHeader,
  EditorPanelSection,
} from '@weldsuite/ui/components/editor-side-panel';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { z } from 'zod';
import type { replaceReachStepsSchema } from '@weldsuite/app-api-client/schemas/reach';
import { insertAtSelection, unknownVariables } from '../../lib/sequence';
import { PreviewPane, type PreviewProspect } from './preview-pane';
import { VariableMenu } from './variable-menu';

export type SequenceValues = z.infer<typeof replaceReachStepsSchema>;

type Field = 'subject' | 'body';

export function StepPanel({
  form,
  index,
  total,
  title,
  disabled,
  campaignId,
  customFields,
  previewProspects,
  onMove,
  onRemove,
  onClose,
}: Readonly<{
  form: UseFormReturn<SequenceValues>;
  index: number;
  total: number;
  title: string;
  disabled: boolean;
  campaignId: string;
  customFields: string[];
  previewProspects: PreviewProspect[];
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onClose: () => void;
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

  const subjectText = form.watch(`steps.${index}.subject`) ?? '';
  const bodyText = form.watch(`steps.${index}.body`) ?? '';
  const unknown = unknownVariables([subjectText, bodyText], customFields);
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
    <>
      <EditorPanelHeader title={title} onClose={onClose} closeLabel={t('reachEngage.sequence.closePanel')} />
      <EditorPanelBody>
        <fieldset disabled={disabled} className="m-0 min-w-0 space-y-4 border-0 p-0">
          {isFirst ? (
            <p className="text-xs text-muted-foreground">{t('reachEngage.sequence.firstEmailHint')}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs">{t('reachEngage.sequence.waitPrefix')}</p>
              <div className="flex flex-wrap items-end gap-3">
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
                <span className="pb-2 text-sm text-muted-foreground">{t('reachEngage.sequence.waitSuffix')}</span>
              </div>
              {(stepErrors?.delayDays || stepErrors?.delayHours) && (
                <p className="text-xs text-destructive">{t('reachEngage.sequence.delayInvalid')}</p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor={`step-${index}-subject`} className="text-xs">
              {t('reachEngage.sequence.subject')}
            </Label>
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

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor={`step-${index}-body`} className="text-xs">
                {t('reachEngage.sequence.body')}
              </Label>
              <VariableMenu customFields={customFields} disabled={disabled} onInsert={insertVariable} />
            </div>
            <Textarea
              id={`step-${index}-body`}
              rows={10}
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
                <p className="text-xs text-muted-foreground">{t('reachEngage.sequence.replyInThreadHint')}</p>
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
        </fieldset>

        <EditorPanelSection title={t('reachEngage.sequence.previewSection')}>
          <PreviewPane
            campaignId={campaignId}
            stepNumber={index + 1}
            subject={subjectText}
            body={bodyText}
            prospects={previewProspects}
          />
        </EditorPanelSection>
      </EditorPanelBody>

      {!disabled && (
        <EditorPanelFooter>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" disabled={index === 0} onClick={() => onMove(-1)}>
              {t('reachEngage.sequence.moveUp')}
            </Button>
            <Button type="button" variant="outline" disabled={index === total - 1} onClick={() => onMove(1)}>
              {t('reachEngage.sequence.moveDown')}
            </Button>
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={total <= 1}
            onClick={onRemove}
          >
            <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
            {t('reachEngage.sequence.removeStep')}
          </Button>
        </EditorPanelFooter>
      )}
    </>
  );
}
