/**
 * A list of short strings, added one at a time or pasted several at once: the
 * allowed domains and the excluded page patterns. Each entry goes through the
 * `parse` the contract gives it (`panelDomainSchema`, `panelUrlPatternSchema`)
 * before it joins the list, so the list always holds valid values.
 *
 * Renders inside a react-hook-form `FormItem`: the input is the form control,
 * so the field's label points at it.
 */

import { useId, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { FormControl } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { useI18n } from '@/lib/i18n/provider';

interface StringListEditorProps {
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** The accepted form of an entry, or `null` when it is not valid. */
  parse: (raw: string) => string | null;
  /** What separates several entries in one paste. */
  separator: RegExp;
  max: number;
  placeholder: string;
  invalidMessage: string;
  duplicateMessage: string;
  disabled?: boolean;
}

export function StringListEditor({
  value,
  onChange,
  parse,
  separator,
  max,
  placeholder,
  invalidMessage,
  duplicateMessage,
  disabled = false,
}: Readonly<StringListEditorProps>) {
  const { t, format } = useI18n();
  const tl = t.weldpanel.listEditor;
  const errorId = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const full = value.length >= max;

  function commit() {
    const tokens = draft.split(separator).filter(Boolean);
    if (tokens.length === 0) {
      setError(null);
      return;
    }
    const accepted = tokens.map(parse);
    if (accepted.some((entry) => entry === null)) {
      setError(invalidMessage);
      return;
    }
    const fresh = [...new Set(accepted as string[])].filter((entry) => !value.includes(entry));
    if (fresh.length === 0) {
      setError(duplicateMessage);
      return;
    }
    onChange([...value, ...fresh].slice(0, max));
    setDraft('');
    setError(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter adds the entry; it must not submit the form around the editor.
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((entry) => (
            <li key={entry} className="flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 font-mono text-[13px]">
              <span className="break-all">{entry}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={disabled}
                aria-label={format(tl.remove, { value: entry })}
                onClick={() => onChange(value.filter((other) => other !== entry))}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-start gap-2">
        <FormControl>
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={onKeyDown}
            // Typed but never added is a lost entry: take a valid one on blur.
            onBlur={commit}
            placeholder={placeholder}
            disabled={disabled || full}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            // Only when there is something to say: an explicit `undefined` would
            // replace what the form field already points at.
            {...(error ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})}
          />
        </FormControl>
        <Button type="button" variant="outline" disabled={disabled || full || draft.trim() === ''} onClick={commit}>
          <Plus />
          {tl.add}
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {full && <p className="text-sm text-muted-foreground">{format(tl.limitReached, { max })}</p>}
    </div>
  );
}
