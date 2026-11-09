import { useEffect, useRef, useState } from 'react';
import type { FieldBlockOf } from '@weldsuite/forms-engine';
import { useFieldEnv, type FieldViewProps } from '../env';

type TextTypes = 'short_text' | 'long_text' | 'email' | 'phone' | 'website';

/** The input attributes of each one-line text field type. */
const INPUT_KIND = {
  short_text: { type: 'text', inputMode: 'text', autoComplete: 'off' },
  email: { type: 'email', inputMode: 'email', autoComplete: 'email' },
  phone: { type: 'tel', inputMode: 'tel', autoComplete: 'tel' },
  website: { type: 'text', inputMode: 'url', autoComplete: 'url' },
} as const satisfies Record<Exclude<TextTypes, 'long_text'>, { type: string; inputMode: string; autoComplete: string }>;

export function TextField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<TextTypes>>) {
  const { labels, conversational } = useFieldEnv();
  const text = typeof value === 'string' ? value : '';
  const shared = {
    id: inputId,
    value: text,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    'aria-required': field.required || undefined,
    'aria-labelledby': `${inputId}-label`,
    'data-wf-focus': '',
  } as const;

  if (field.type === 'long_text') {
    return (
      <div>
        <textarea
          {...shared}
          className="wf-input wf-textarea"
          rows={3}
          placeholder={field.properties.placeholder ?? labels.typeAnswer}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
        {conversational ? <p className="wf-hint">{labels.shiftEnterHint}</p> : null}
      </div>
    );
  }

  const placeholder =
    field.type === 'short_text' || field.type === 'email' || field.type === 'website'
      ? (field.properties.placeholder ?? labels.typeAnswer)
      : labels.typeAnswer;
  const kind = INPUT_KIND[field.type];
  return (
    <input
      {...shared}
      {...kind}
      className="wf-input"
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    />
  );
}

/** Keeps the typed text (a trailing dot, a minus) while the stored answer is the parsed number. */
export function NumberField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'number'>>) {
  const { labels } = useFieldEnv();
  const [text, setText] = useState(() => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''));
  const lastEmitted = useRef<unknown>(value);

  // Follow outside changes (resume, reset) but not our own.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setText(typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
    }
  }, [value]);

  function change(next: string) {
    setText(next);
    const trimmed = next.trim().replace(',', '.');
    let parsed: number | undefined;
    if (trimmed === '') parsed = undefined;
    else {
      const n = Number(trimmed);
      // NaN is an answer of the wrong shape: the engine reports `invalid` instead of "required".
      parsed = trimmed === '-' || trimmed === '.' || Number.isNaN(n) ? Number.NaN : n;
    }
    lastEmitted.current = parsed;
    onChange(parsed);
  }

  return (
    <input
      id={inputId}
      className="wf-input"
      type="text"
      inputMode={field.properties.decimals > 0 || (field.properties.min ?? 0) < 0 ? 'decimal' : 'numeric'}
      autoComplete="off"
      value={text}
      placeholder={labels.typeAnswer}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      aria-required={field.required || undefined}
      aria-labelledby={`${inputId}-label`}
      data-wf-focus=""
      onChange={(e) => change(e.target.value)}
    />
  );
}
