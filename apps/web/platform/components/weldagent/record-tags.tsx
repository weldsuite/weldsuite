/**
 * `@` tagging in the WeldAgent composer: type `@` and part of a name to tag a
 * spreadsheet or another record. The textarea shows `@Name`; the message goes
 * out with the WeldChat entity token (`<@sheet:id|Name>`), which the agent
 * reads as that record with its id, and which the chat shows as a chip
 * (ADR AGENT-015).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { useGlobalSearch } from '@/hooks/queries/use-global-search-queries';
import { RESULT_TYPE_ICON, RESULT_TYPE_LABEL } from '@/lib/search/result-types';
import { encodeEntityToken, parseChatTokens } from '@/app/weldchat/lib/render-tokens';
import type { EntitySheetType } from '@/components/entity-sheet/types';
import { VALID_TYPES } from '@/components/entity-sheet/url-param';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** An `@` at the start or after a space, and what follows it up to the caret. */
const TAG_QUERY = /(?:^|\s)@([^\s@]{0,40})$/;
/** Records offered at once. */
const MAX_OPTIONS = 8;

interface Tag {
  label: string;
  token: string;
}

interface TagQuery {
  /** Where the `@` is. */
  start: number;
  /** The caret. */
  end: number;
  query: string;
}

interface RecordOption {
  type: EntitySheetType;
  id: string;
  title: string;
}

/** The `@query` the caret is in, or null. */
export function tagQueryAt(text: string, caret: number): TagQuery | null {
  const match = TAG_QUERY.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, end: caret, query: match[1] };
}

/** The text to send: every picked tag still written as `@Name` becomes its token. */
export function withTagTokens(text: string, tags: readonly Tag[]): string {
  // Longest first, so `@Budget` does not take the start of `@Budget 2026`.
  const byLength = [...tags].sort((a, b) => b.label.length - a.label.length);
  let out = text;
  // A replacer function, so a `$` in a record's name is not read as a replacement pattern.
  for (const tag of byLength) out = out.replace(`@${tag.label}`, () => tag.token);
  return out;
}

/** A message with its tags written as `@Name`, for titles and previews. */
export function tagsAsText(text: string): string {
  return parseChatTokens(text)
    .map((seg) => {
      if (seg.kind === 'text') return seg.text;
      if (seg.kind === 'entity') return `@${seg.label ?? seg.entityType}`;
      if (seg.kind === 'user') return `@${seg.displayName ?? seg.userId}`;
      return '';
    })
    .join('');
}

/**
 * The tagging state of one composer: which `@query` the caret is in, the
 * records that match, and the tags picked so far (cleared with the text).
 */
export function useRecordTags(
  value: string,
  onChange: (value: string) => void,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
) {
  const tags = useRef<Tag[]>([]);
  const [current, setCurrent] = useState<TagQuery | null>(null);
  const currentRef = useRef<TagQuery | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!value) tags.current = [];
  }, [value]);

  // The text can change without the textarea (sent and cleared, a prefill): only an `@` still there counts.
  const open = current !== null && !dismissed && value[current.start] === '@';
  const search = useGlobalSearch(current?.query ?? '', { enabled: open, limit: 4 });
  const options = useMemo<RecordOption[]>(() => {
    const groups = [...(search.data?.data ?? [])];
    // Spreadsheets first: they are what an agent most often works in.
    groups.sort((a, b) => Number(b.type === 'sheet') - Number(a.type === 'sheet'));
    return (
      groups
        // Only types a chat token can name (the server also returns knowledge pages, which it cannot).
        .filter((g) => VALID_TYPES.has(g.type))
        .flatMap((g) => g.items.map((item) => ({ type: g.type as EntitySheetType, id: item.id, title: item.title })))
        .slice(0, MAX_OPTIONS)
    );
  }, [search.data]);

  /** Follow the caret: called on every change and selection move of the textarea. */
  const sync = useCallback((textarea: HTMLTextAreaElement) => {
    const next = tagQueryAt(textarea.value, textarea.selectionStart ?? textarea.value.length);
    const prev = currentRef.current;
    if (prev?.start === next?.start && prev?.query === next?.query && prev?.end === next?.end) return;
    // A new `@` reopens a menu closed with Escape; a new query starts at the top.
    if (prev?.start !== next?.start) {
      setDismissed(false);
      setActive(0);
    } else if (prev?.query !== next?.query) {
      setActive(0);
    }
    currentRef.current = next;
    setCurrent(next);
  }, []);

  const pick = useCallback(
    (option: RecordOption) => {
      if (!current) return;
      const label = option.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || RESULT_TYPE_LABEL[option.type] || option.type;
      const insert = `@${label} `;
      tags.current = [
        ...tags.current.filter((tag) => tag.label !== label),
        { label, token: encodeEntityToken(option.type, option.id, label) },
      ];
      onChange(value.slice(0, current.start) + insert + value.slice(current.end));
      currentRef.current = null;
      setCurrent(null);
      const caret = current.start + insert.length;
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
    },
    [current, onChange, textareaRef, value],
  );

  /** Keys the open menu takes; true when it took this one. */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return true;
      }
      if (options.length === 0) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + options.length) % options.length);
        return true;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        pick(options[Math.min(active, options.length - 1)]);
        return true;
      }
      return false;
    },
    [active, open, options, pick],
  );

  const toSend = useCallback((text: string) => withTagTokens(text, tags.current), []);

  const menu: ReactNode = open && current ? (
    <RecordTagMenu
      query={current.query}
      options={options}
      active={active}
      loading={search.isFetching}
      onHover={setActive}
      onPick={pick}
    />
  ) : null;

  return { sync, onKeyDown, toSend, menu, open };
}

function RecordTagMenu({
  query,
  options,
  active,
  loading,
  onHover,
  onPick,
}: Readonly<{
  query: string;
  options: RecordOption[];
  active: number;
  loading: boolean;
  onHover: (index: number) => void;
  onPick: (option: RecordOption) => void;
}>) {
  const t = getTranslations('common').ai.chat.mentions;
  let status: string | null = null;
  if (!query) status = t.hint;
  else if (options.length === 0) status = loading ? t.searching : t.noResults.replace('{query}', query);

  return (
    <div
      role="listbox"
      aria-label={t.label}
      className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-md"
      data-testid="record-tag-menu"
    >
      {status ? (
        <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-muted-foreground">
          {loading && query ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {status}
        </div>
      ) : (
        options.map((option, index) => {
          const Icon = RESULT_TYPE_ICON[option.type];
          return (
            <button
              key={`${option.type}-${option.id}`}
              type="button"
              role="option"
              aria-selected={index === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(option)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm',
                index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
              )}
            >
              {Icon ? <Icon className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
              <span className="min-w-0 flex-1 truncate">{option.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{RESULT_TYPE_LABEL[option.type] ?? option.type}</span>
            </button>
          );
        })
      )}
    </div>
  );
}
