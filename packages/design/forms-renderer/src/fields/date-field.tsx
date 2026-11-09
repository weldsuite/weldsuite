import { useRef, useState } from 'react';
import type { FieldBlockOf } from '@weldsuite/forms-engine';
import { useFieldEnv, type FieldViewProps } from '../env';

type Part = 'day' | 'month' | 'year';

const ORDER: Record<'DMY' | 'MDY' | 'YMD', Part[]> = {
  DMY: ['day', 'month', 'year'],
  MDY: ['month', 'day', 'year'],
  YMD: ['year', 'month', 'day'],
};

function split(value: unknown): Record<Part, string> {
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) return { year: m[1] ?? '', month: String(Number(m[2])), day: String(Number(m[3])) };
  }
  return { day: '', month: '', year: '' };
}

/** `YYYY-MM-DD` when all three are filled; a deliberately invalid string when only some are, so the engine says `invalid_date`. */
function join(parts: Record<Part, string>): string | undefined {
  const { day, month, year } = parts;
  if (!day && !month && !year) return undefined;
  const y = year ? year.padStart(4, '0') : '????';
  const m = month ? month.padStart(2, '0') : '??';
  const d = day ? day.padStart(2, '0') : '??';
  return `${y}-${m}-${d}`;
}

export function DateField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'date'>>) {
  const { labels } = useFieldEnv();
  const [parts, setParts] = useState(() => split(value));
  const refs = useRef<Partial<Record<Part, HTMLInputElement | null>>>({});
  const order = ORDER[field.properties.format];
  const maxLen: Record<Part, number> = { day: 2, month: 2, year: 4 };
  const names: Record<Part, string> = { day: labels.day, month: labels.month, year: labels.year };
  const autocomplete: Record<Part, string> = { day: 'bday-day', month: 'bday-month', year: 'bday-year' };

  function change(part: Part, raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, maxLen[part]);
    const next = { ...parts, [part]: digits };
    setParts(next);
    onChange(join(next));
    if (digits.length === maxLen[part]) {
      const nextPart = order[order.indexOf(part) + 1];
      if (nextPart) refs.current[nextPart]?.focus();
    }
  }

  return (
    <div className="wf-date" role="group" aria-labelledby={`${inputId}-label`} aria-describedby={describedBy}>
      {order.map((part, i) => (
        <label key={part} className={part === 'year' ? 'wf-date-part wf-date-year' : 'wf-date-part'}>
          <span className="wf-sublabel">{names[part]}</span>
          <input
            ref={(el) => {
              refs.current[part] = el;
            }}
            id={i === 0 ? inputId : undefined}
            className="wf-input"
            type="text"
            inputMode="numeric"
            autoComplete={autocomplete[part]}
            placeholder={part === 'year' ? 'YYYY' : part === 'month' ? 'MM' : 'DD'}
            value={parts[part]}
            aria-invalid={error ? true : undefined}
            data-wf-focus={i === 0 ? '' : undefined}
            onChange={(e) => change(part, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}
