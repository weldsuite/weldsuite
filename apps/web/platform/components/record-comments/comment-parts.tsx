import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { CHAT_TOKEN, tokenLabel } from './mentions';

/** Someone who can be mentioned. */
export interface Person {
  id: string;
  name: string;
}

export interface ComposerLabels {
  placeholder: string;
  submit: string;
  cancel: string;
  noMatch: string;
}

/**
 * A comment box: Ctrl+Enter posts; typing @ offers the people to mention.
 * While `onSubmit` runs the box waits; when it fails the text stays.
 */
export function CommentComposer({
  people,
  labels,
  initial = '',
  autoFocus,
  onSubmit,
  onCancel,
}: {
  people: Person[];
  labels: ComposerLabels;
  initial?: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [query, setQuery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const matches = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [people, query]);

  const update = (value: string) => {
    setBody(value);
    const caret = ref.current?.selectionStart ?? value.length;
    const m = /@([^\s@[\]()]*)$/.exec(value.slice(0, caret));
    setQuery(m && people.length ? m[1]! : null);
  };

  const mention = (p: Person) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/@[^\s@[\]()]*$/, '');
    setBody(`${before}@[${p.name.replace(/[[\]]/g, '')}](${p.id}) ${body.slice(caret)}`);
    setQuery(null);
    requestAnimationFrame(() => el?.focus());
  };

  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setBody('');
      setQuery(null);
    } catch {
      // The caller says what went wrong; the text stays to try again.
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Enter' && matches.length) {
      e.preventDefault();
      mention(matches[0]!);
    } else if (e.key === 'Escape') {
      if (query === null) onCancel?.();
      else setQuery(null);
    }
  };

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={body}
        placeholder={labels.placeholder}
        autoFocus={autoFocus}
        rows={2}
        maxLength={10_000}
        disabled={busy}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
      />
      {query !== null && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border bg-popover p-1 text-sm shadow-md">
          {matches.length === 0 && <div className="px-2 py-1 text-muted-foreground">{labels.noMatch}</div>}
          {matches.map((p) => (
            <button key={p.id} type="button" className="block w-full truncate rounded px-2 py-1 text-left hover:bg-accent" onMouseDown={(e) => e.preventDefault()} onClick={() => mention(p)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex justify-end gap-1">
        {onCancel && (
          <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={onCancel}>
            {labels.cancel}
          </Button>
        )}
        <Button size="sm" className="h-7" disabled={!body.trim() || busy} onClick={() => void submit()}>
          {labels.submit}
        </Button>
      </div>
    </div>
  );
}

/** A comment's text, its mentions shown as names. */
export function CommentBody({ content, names }: { content: string; names?: ReadonlyMap<string, string> }) {
  const parts: (string | { label: string; key: number })[] = [];
  let last = 0;
  for (const m of content.matchAll(CHAT_TOKEN)) {
    parts.push(content.slice(last, m.index), { label: tokenLabel(m[1]!, names), key: m.index! });
    last = m.index! + m[0].length;
  }
  parts.push(content.slice(last));
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <span key={`${p.key}-${i}`} className="rounded bg-primary/10 px-0.5 font-medium text-primary">
            @{p.label}
          </span>
        ),
      )}
    </p>
  );
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}
