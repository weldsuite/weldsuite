/**
 * The options of a choice, dropdown, picture or ranking field: edit labels,
 * add and remove, reorder, paste many at once, and (quizzes) points and the
 * correct answer per option.
 */

import { useState } from 'react';
import { ArrowDown, ArrowUp, ClipboardPaste, Plus, Trash2 } from 'lucide-react';
import { createChoice, type FormChoice } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import { reorder } from '../lib/blocks';
import { ImageUrlField } from './media-fields';

/** One option per non-empty line; surrounding whitespace and bullets are dropped. */
export function parsePastedChoices(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line !== '');
}

interface Props {
  choices: FormChoice[];
  onChange: (choices: FormChoice[], coalesceKey?: string) => void;
  /** At most this many options (the field type's limit). */
  max: number;
  min?: number;
  /** Show the picture upload per option. */
  pictures?: boolean;
  /** Show points and "correct" per option. */
  scoring?: boolean;
  disabled?: boolean;
}

export function ChoicesEditor({ choices, onChange, max, min = 1, pictures, scoring, disabled }: Readonly<Props>) {
  const { t } = useI18n();
  const tc = t.weldforms.choices;
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');

  const patch = (index: number, change: Partial<FormChoice>, key?: string) =>
    onChange(
      choices.map((c, i) => (i === index ? { ...c, ...change } : c)),
      key,
    );

  function add() {
    if (choices.length >= max) return;
    onChange([...choices, createChoice(`${tc.option} ${choices.length + 1}`)]);
  }

  function applyPaste(replace: boolean) {
    const labels = parsePastedChoices(pasted);
    if (labels.length === 0) return;
    const base = replace ? [] : choices;
    const next = [...base, ...labels.map((label) => createChoice(label))].slice(0, max);
    onChange(next);
    setPasted('');
    setPasting(false);
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {choices.map((choice, index) => (
          <li key={choice.id} className="space-y-1.5 rounded-md border bg-card p-1.5">
            <div className="flex items-center gap-1">
              <Input
                value={choice.label}
                onChange={(e) => patch(index, { label: e.target.value }, `choice:${choice.id}`)}
                placeholder={`${tc.option} ${index + 1}`}
                aria-label={`${tc.option} ${index + 1}`}
                maxLength={500}
                disabled={disabled}
                className="h-8"
              />
              <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || index === 0} onClick={() => onChange(reorder(choices, index, index - 1))} aria-label={tc.moveUp}>
                <ArrowUp />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || index === choices.length - 1} onClick={() => onChange(reorder(choices, index, index + 1))} aria-label={tc.moveDown}>
                <ArrowDown />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || choices.length <= min} onClick={() => onChange(choices.filter((_, i) => i !== index))} aria-label={t.common.actions.remove}>
                <Trash2 />
              </Button>
            </div>
            {pictures && <ImageUrlField label={tc.picture} compact value={choice.imageUrl} disabled={disabled} onChange={(imageUrl) => patch(index, { imageUrl })} />}
            {scoring && (
              <div className="flex items-center gap-3 px-1">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {tc.points}
                  <Input
                    type="number"
                    value={choice.score ?? ''}
                    onChange={(e) => patch(index, { score: e.target.value === '' ? undefined : Number(e.target.value) }, `score:${choice.id}`)}
                    disabled={disabled}
                    className="h-7 w-16 px-2 text-sm"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox checked={choice.correct === true} onCheckedChange={(checked) => patch(index, { correct: checked === true ? true : undefined })} disabled={disabled} />
                  {tc.correct}
                </label>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled || choices.length >= max}>
          <Plus className="size-4" />
          {tc.add}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="sm" onClick={() => setPasting(true)} disabled={disabled}>
              <ClipboardPaste className="size-4" />
              {tc.pasteMany}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tc.pasteHint}</TooltipContent>
        </Tooltip>
      </div>

      <Dialog open={pasting} onOpenChange={setPasting}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tc.pasteTitle}</DialogTitle>
            <DialogDescription>{tc.pasteDescription}</DialogDescription>
          </DialogHeader>
          <Textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={8} aria-label={tc.pasteTitle} autoFocus />
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => setPasting(false)}>
              {t.common.actions.cancel}
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => applyPaste(true)} disabled={parsePastedChoices(pasted).length === 0}>
                {tc.replace}
              </Button>
              <Button type="button" onClick={() => applyPaste(false)} disabled={parsePastedChoices(pasted).length === 0}>
                {tc.append}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
