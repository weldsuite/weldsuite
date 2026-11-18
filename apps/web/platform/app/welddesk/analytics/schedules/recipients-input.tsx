/**
 * Recipients as chips: type an address and press Enter, comma or Tab (or leave
 * the field) to add it. Invalid addresses are refused with a message,
 * duplicates are ignored and the list stops at `max`.
 */

import { useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { z } from 'zod';
import { Input } from '@weldsuite/ui/components/input';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';

const emailSchema = z.string().email().max(254);

export interface RecipientsLabels {
  placeholder: string;
  invalid: (email: string) => string;
  tooMany: string;
  remove: (email: string) => string;
}

/** Adds `raw` (one or several addresses split on commas, semicolons or spaces) to `current`. */
export function addRecipients(
  current: string[],
  raw: string,
  max: number,
): { next: string[]; invalid: string | null; full: boolean } {
  const next = [...current];
  for (const token of raw.split(/[,;\s]+/)) {
    const email = token.trim().toLowerCase();
    if (!email || next.includes(email)) continue;
    if (!emailSchema.safeParse(email).success) return { next, invalid: email, full: false };
    if (next.length >= max) return { next, invalid: null, full: true };
    next.push(email);
  }
  return { next, invalid: null, full: false };
}

export function RecipientsInput({
  id,
  value,
  onChange,
  max,
  labels,
  disabled,
}: Readonly<{
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  max: number;
  labels: RecipientsLabels;
  disabled?: boolean;
}>) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const commit = (raw: string) => {
    if (!raw.trim()) return;
    const result = addRecipients(value, raw, max);
    onChange(result.next);
    if (result.invalid) {
      setProblem(labels.invalid(result.invalid));
      setText(result.invalid);
    } else if (result.full) {
      setProblem(labels.tooMany);
      setText('');
    } else {
      setProblem(null);
      setText('');
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(text);
    } else if (event.key === 'Tab' && text.trim()) {
      commit(text);
    } else if (event.key === 'Backspace' && !text && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((email) => (
            <li key={email}>
              <SoftBadge tone="neutral" className="gap-1 pr-1">
                {email}
                <button
                  type="button"
                  aria-label={labels.remove(email)}
                  className="rounded-full p-0.5 hover:bg-foreground/10"
                  disabled={disabled}
                  onClick={() => onChange(value.filter((other) => other !== email))}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </SoftBadge>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id}
        inputMode="email"
        autoComplete="off"
        value={text}
        disabled={disabled}
        placeholder={labels.placeholder}
        onChange={(event) => {
          setText(event.target.value);
          if (problem) setProblem(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(text)}
        aria-invalid={problem ? true : undefined}
      />
      {problem && <p className="text-sm text-destructive">{problem}</p>}
    </div>
  );
}
