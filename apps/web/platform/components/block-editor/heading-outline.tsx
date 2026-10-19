import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { getBlockEditorStrings } from './strings';
import type { BlockNoteEditorInstance } from './block-editor';

// ============================================================================
// Heading outline rail: one short line per heading down the side of the page.
// The heading in view is highlighted; hovering a line shows the heading with
// a preview of the text under it, and clicking it scrolls there.
// ============================================================================

export interface OutlineEntry {
  id: string;
  level: number;
  text: string;
  /** Text of the blocks between this heading and the next one. */
  preview: string;
}

const PREVIEW_LENGTH = 220;

/** Plain text of a block's inline content (styled text and links). */
function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((node) => {
      if (!node || typeof node !== 'object') return '';
      const item = node as { text?: unknown; content?: unknown };
      if (typeof item.text === 'string') return item.text;
      return inlineText(item.content);
    })
    .join('');
}

/** Every heading in reading order (nested blocks included), each with a preview of what follows it. */
export function collectOutline(blocks: unknown): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      const block = node as { id?: string; type?: string; props?: { level?: unknown }; content?: unknown; children?: unknown };
      const text = inlineText(block.content).trim();
      if (block.type === 'heading' && block.id) {
        const level = typeof block.props?.level === 'number' ? block.props.level : 1;
        entries.push({ id: block.id, level, text, preview: '' });
      } else if (text) {
        const current = entries.at(-1);
        if (current && current.preview.length < PREVIEW_LENGTH) {
          current.preview = current.preview ? `${current.preview} ${text}` : text;
        }
      }
      walk(block.children);
    }
  };
  walk(blocks);
  return entries;
}

// Line length by heading level; the heading in view gets a longer, bright line.
const LINE_WIDTH: Record<number, number> = { 1: 16, 2: 12, 3: 8 };
const ACTIVE_EXTRA = 8;
/** How far below the top of the scroll area a heading counts as "in view". */
const ACTIVE_OFFSET = 96;

function findHeading(editor: BlockNoteEditorInstance, id: string): HTMLElement | null {
  const root = (editor as unknown as { domElement?: HTMLElement }).domElement;
  return root?.querySelector<HTMLElement>(`[data-node-type="blockContainer"][data-id="${id}"]`) ?? null;
}

export function HeadingOutline({
  editor,
  scrollRef,
  className,
}: Readonly<{
  editor: BlockNoteEditorInstance;
  /** The element the page scrolls in, used to track which heading is in view. */
  scrollRef: RefObject<HTMLElement | null>;
  className?: string;
}>) {
  const strings = getBlockEditorStrings();
  const [entries, setEntries] = useState<OutlineEntry[]>(() => collectOutline(editor.document));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const refresh = () => {
      const next = collectOutline(editor.document);
      setEntries((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    refresh();
    return editor.onChange(refresh);
  }, [editor]);

  // The active heading is the last one scrolled past the top of the page.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || entries.length === 0) return;
    const update = () => {
      const top = scroller.getBoundingClientRect().top + ACTIVE_OFFSET;
      let current = entries[0].id;
      for (const entry of entries) {
        const el = findHeading(editor, entry.id);
        if (el && el.getBoundingClientRect().top <= top) current = entry.id;
      }
      // Scrolled to the very bottom, the last headings may never reach the top.
      if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        current = entries.at(-1)!.id;
      }
      setActiveId(current);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      scroller.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [editor, entries, scrollRef]);

  // Centre on the whole window, not on the area the rail is placed in (which
  // starts below the app header): set `top` against the positioned parent.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const place = () => {
      const parent = nav.offsetParent;
      if (!parent) return;
      nav.style.top = `${window.innerHeight / 2 - parent.getBoundingClientRect().top}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [entries.length]);

  const scrollTo = useCallback(
    (id: string) => {
      findHeading(editor, id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [editor],
  );

  // A single heading isn't an outline.
  if (entries.length < 2) return null;

  return (
    <nav
      ref={navRef}
      aria-label={strings.slashMenu.items.tableOfContents.title}
      className={cn('flex flex-col items-start', className)}
      onMouseLeave={() => setHoveredId(null)}
    >
      {entries.map((entry) => {
        const isActive = entry.id === activeId;
        const width = (LINE_WIDTH[entry.level] ?? LINE_WIDTH[3]) + (isActive ? ACTIVE_EXTRA : 0);
        const label = entry.text || strings.tableOfContents.untitled;
        return (
          <div key={entry.id} className="relative">
            <button
              type="button"
              aria-label={label}
              aria-current={isActive ? 'location' : undefined}
              onClick={() => scrollTo(entry.id)}
              onMouseEnter={() => setHoveredId(entry.id)}
              onFocus={() => setHoveredId(entry.id)}
              onBlur={() => setHoveredId(null)}
              className="flex h-2.5 w-8 cursor-pointer items-center outline-none"
            >
              <span
                className={cn(
                  'h-0.5 rounded-full',
                  isActive ? 'bg-foreground' : 'bg-muted-foreground/40',
                  hoveredId === entry.id && !isActive && 'bg-muted-foreground',
                )}
                style={{ width }}
              />
            </button>
            {hoveredId === entry.id ? (
              <div className="pointer-events-none absolute left-full top-1/2 z-30 ml-3 w-72 -translate-y-5 rounded-xl border bg-popover px-3.5 py-3 text-popover-foreground shadow-md">
                <p className="truncate text-[13px] font-medium">{label}</p>
                {entry.preview ? (
                  <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-muted-foreground">{entry.preview}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
