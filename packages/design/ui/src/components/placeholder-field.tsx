'use client';

import { useId, useRef } from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { cn } from '@weldsuite/ui/lib/utils';

export interface PlaceholderOption {
  /** What is written into the text, without braces, e.g. `customerName`. */
  key: string;
  /** What the chip says, e.g. "Customer name". */
  label: string;
}

export interface PlaceholderFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholders: readonly PlaceholderOption[];
  /** One line (a subject) or several (a body). */
  multiline?: boolean;
  rows?: number;
  id?: string;
  name?: string;
  /** Names the field when no `<label htmlFor>` does. */
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  /** Said in front of each chip's name for assistive technology, e.g. "Insert". */
  insertLabel: string;
  /** Names the group of chips, e.g. "Placeholders". */
  chipsLabel: string;
  maxLength?: number;
  className?: string;
  disabled?: boolean;
}

/** How a placeholder is written in the text. */
export function placeholderToken(key: string): string {
  return `{${key}}`;
}

/**
 * A text field with the placeholders it may hold as chips underneath: a click
 * inserts the placeholder at the cursor (or replaces the selection) and keeps
 * the focus in the field, so writing goes on. The chips are real buttons in
 * the tab order. It holds no translations: every word comes from props.
 */
export function PlaceholderField({
  value,
  onChange,
  placeholders,
  multiline = true,
  rows = 6,
  id,
  name,
  insertLabel,
  chipsLabel,
  className,
  ...rest
}: Readonly<PlaceholderFieldProps>) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const insert = (key: string) => {
    const token = placeholderToken(key);
    const element = field.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    // The value is controlled: put the cursor after the token once React has written it.
    const caret = start + token.length;
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      {multiline ? (
        <Textarea
          {...rest}
          ref={(element) => {
            field.current = element;
          }}
          id={fieldId}
          name={name}
          rows={rows}
          value={value}
          spellCheck
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          {...rest}
          ref={(element) => {
            field.current = element;
          }}
          id={fieldId}
          name={name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <div role="group" aria-label={chipsLabel} className="flex flex-wrap gap-1.5">
        {placeholders.map((placeholder) => (
          <button
            key={placeholder.key}
            type="button"
            aria-label={`${insertLabel} ${placeholder.label}`}
            disabled={rest.disabled}
            onClick={() => insert(placeholder.key)}
            className="inline-flex min-h-6 items-center rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
          >
            {placeholder.label}
          </button>
        ))}
      </div>
    </div>
  );
}
