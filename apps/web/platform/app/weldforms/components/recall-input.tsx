/**
 * A text input or textarea with an "insert recall" menu: `{{field:ref}}`,
 * `{{hidden:name}}` and `{{var:name}}` put an earlier answer, a hidden value or
 * a variable into a title, description or redirect URL.
 */

import { useRef } from 'react';
import { Braces } from 'lucide-react';
import type { FormDefinition } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useI18n } from '@/lib/i18n/provider';
import { readableFields } from '../lib/logic-ops';

export interface RecallOption {
  token: string;
  label: string;
  group: 'fields' | 'hidden' | 'variables';
}

/**
 * What can be recalled at a point of the form. `sourceIndex` is the top-level
 * index of the block being edited: only questions before it are offered; null
 * (endings, redirect URLs) offers all of them.
 */
export function recallOptions(def: FormDefinition, sourceIndex: number | null): RecallOption[] {
  const fields = readableFields(def, sourceIndex === null ? null : sourceIndex - 1);
  return [
    ...fields.map((f) => ({ token: `{{field:${f.ref}}}`, label: f.title || f.ref, group: 'fields' as const })),
    ...def.hidden.map((h) => ({ token: `{{hidden:${h.name}}}`, label: h.name, group: 'hidden' as const })),
    ...['score', ...def.variables.map((v) => v.name)].map((name) => ({ token: `{{var:${name}}}`, label: name, group: 'variables' as const })),
  ];
}

/** Puts `token` at the caret (or replaces the selection) and returns the new text and caret position. */
export function insertAtCaret(text: string, token: string, start: number | null, end: number | null): { text: string; caret: number } {
  const from = start ?? text.length;
  const to = end ?? from;
  return { text: text.slice(0, from) + token + text.slice(to), caret: from + token.length };
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  definition: FormDefinition;
  sourceIndex: number | null;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  ariaLabel: string;
  id?: string;
}

export function RecallInput({ value, onChange, definition, sourceIndex, multiline, rows = 3, placeholder, maxLength, disabled, ariaLabel, id }: Readonly<Props>) {
  const { t } = useI18n();
  const tr = t.weldforms.recall;
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const options = recallOptions(definition, sourceIndex);

  function insert(token: string) {
    const el = ref.current;
    const result = insertAtCaret(value, token, el?.selectionStart ?? null, el?.selectionEnd ?? null);
    onChange(result.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(result.caret, result.caret);
    });
  }

  const groups: Array<{ id: RecallOption['group']; label: string }> = [
    { id: 'fields', label: tr.fields },
    { id: 'hidden', label: tr.hidden },
    { id: 'variables', label: tr.variables },
  ];

  return (
    <div className="relative">
      {multiline ? (
        <Textarea
          id={id}
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={disabled}
          aria-label={ariaLabel}
          className="pr-9"
        />
      ) : (
        <Input id={id} ref={ref} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength} disabled={disabled} aria-label={ariaLabel} className="pr-9" />
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" disabled={disabled} className="absolute right-1.5 top-1.5" aria-label={tr.insert} title={tr.insert}>
            <Braces />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="max-h-72 w-72 overflow-y-auto p-2">
          {groups.map((group) => {
            const items = options.filter((o) => o.group === group.id);
            if (items.length === 0) return null;
            return (
              <div key={group.id} className="mb-2 last:mb-0">
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{group.label}</div>
                {items.map((option) => (
                  <button
                    key={option.token}
                    type="button"
                    onClick={() => insert(option.token)}
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="truncate">{option.label}</span>
                    <code className="shrink-0 text-[10px] text-muted-foreground">{option.token}</code>
                  </button>
                ))}
              </div>
            );
          })}
          {options.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">{tr.none}</p>}
        </PopoverContent>
      </Popover>
    </div>
  );
}
