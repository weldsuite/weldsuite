import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { formatShortcut, isMacPlatform } from '@weldsuite/ui/lib/shortcut';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { TOOL_DRAG_TYPE, type ToolKind } from './model/tools';

// Toolbar building blocks for the board editor. Buttons keep focus on the
// board (mousedown is prevented), so a click acts on the selection. A tool
// that drags onto the board lets mousedown through (a drag needs it); picking
// a tool changes the board, which takes focus back.

/** Props that let a toolbar button be dragged onto the board as `tool`. */
function toolDrag(tool: ToolKind | undefined) {
  if (!tool) return { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() };
  return {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLButtonElement>) => {
      e.dataTransfer.setData(TOOL_DRAG_TYPE, tool);
      e.dataTransfer.effectAllowed = 'copy';
    },
  };
}

/**
 * One panel in the board's right-hand side panel (frames, facilitation,
 * comments, versions): its header and a body that scrolls. Two open at once
 * share the height.
 */
export const SIDE_PANEL = 'flex min-h-0 flex-1 flex-col bg-background';
/** A side panel's heading row: as tall as the board's tool row (48px), so the two line up side by side. */
export const SIDE_PANEL_HEADER = 'flex h-12 shrink-0 items-center justify-between border-b px-3';

export const TOOL_BUTTON =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[18px]';
export const BAR_BUTTON =
  'inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-sm text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4';

/** The side a tooltip or panel opens on. */
type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

/**
 * A shortcut, written once with platform-neutral tokens (`mod`, `shift`, `alt`
 * and the key): "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere.
 */
export type Shortcut = readonly string[];

/** `aria-keyshortcuts` for a shortcut ("Control+Shift+Z", "Meta+Shift+Z"). */
function ariaShortcut(keys: Shortcut | undefined): string | undefined {
  if (!keys?.length) return undefined;
  const names: Record<string, string> = { mod: isMacPlatform() ? 'Meta' : 'Control', shift: 'Shift', alt: 'Alt' };
  return keys.map((k) => names[k] ?? k).join('+');
}

/** The label and, after it, the shortcut in a quieter tone. */
export function TooltipLabel({ label, keys }: { label: string; keys?: Shortcut }) {
  return (
    <span className="flex items-center gap-2">
      {label}
      {keys?.length ? <span className="font-medium tabular-nums opacity-60">{formatShortcut(keys)}</span> : null}
    </span>
  );
}

export function WithTooltip({ label, keys, side, children }: { label: string; keys?: Shortcut; side?: TooltipSide; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <TooltipLabel label={label} keys={keys} />
      </TooltipContent>
    </Tooltip>
  );
}

export function BarButton({
  label,
  keys,
  onClick,
  active,
  disabled,
  className,
  side,
  children,
  onDoubleClick,
  dragTool,
}: {
  label: string;
  /** Its keyboard shortcut, shown in the tooltip. */
  keys?: Shortcut;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  side?: TooltipSide;
  children: ReactNode;
  onDoubleClick?: () => void;
  /** Can be dragged onto the board to place this tool there. */
  dragTool?: ToolKind;
}) {
  return (
    <WithTooltip label={label} keys={keys} side={side}>
      <button
        type="button"
        className={cn(className ?? BAR_BUTTON, active && 'bg-primary/10 text-primary hover:bg-primary/15')}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        aria-keyshortcuts={ariaShortcut(keys)}
        {...toolDrag(dragTool)}
      >
        {children}
      </button>
    </WithTooltip>
  );
}

export function Divider({ vertical = true }: { vertical?: boolean }) {
  return vertical ? <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden /> : <div className="my-1 h-px w-6 shrink-0 bg-border" aria-hidden />;
}

/**
 * A toolbar button that opens a small panel. `children` may be a function of
 * `close`, for a panel that closes once something is picked in it.
 */
export function BarPopover({
  label,
  keys,
  trigger,
  children,
  side = 'bottom',
  tooltipSide = side === 'right' ? 'right' : 'top',
  active,
  className,
  open,
  onOpenChange,
  dragTool,
}: {
  label: string;
  keys?: Shortcut;
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  side?: TooltipSide;
  /** Where its tooltip opens: above by default, below in the board's top toolbar (clear of the header). */
  tooltipSide?: TooltipSide;
  active?: boolean;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Can be dragged onto the board to place this tool there. */
  dragTool?: ToolKind;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <WithTooltip label={label} keys={keys} side={tooltipSide}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            aria-keyshortcuts={ariaShortcut(keys)}
            // Stays highlighted while its menu is open (`data-state` is the tooltip's here, so `aria-expanded`).
            className={cn(className ?? BAR_BUTTON, 'aria-expanded:bg-accent', active && 'bg-primary/10 text-primary aria-expanded:bg-primary/15')}
            {...toolDrag(dragTool)}
          >
            {trigger}
          </button>
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent
        side={side}
        align="start"
        className="w-auto p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // Escape closes this panel only: the board would otherwise also take it (and drop the tool picked here).
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        {typeof children === 'function' ? children(() => setOpen(false)) : children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A row that scrolls sideways when there is more than fits: its edges fade
 * where there is more to see, a chevron there scrolls on, and a mouse wheel
 * scrolls it. Each end is a marker watched by an IntersectionObserver
 * (scroll-driven animations are not widely available yet); scroll padding
 * keeps a focused item out of the fades. `className` styles the row itself,
 * `outerClassName` the box around it.
 */
export function ScrollFade({ children, className, outerClassName }: { children: ReactNode; className?: string; outerClassName?: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const startMark = useRef<HTMLSpanElement>(null);
  const endMark = useRef<HTMLSpanElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const root = ref.current;
    const first = startMark.current;
    const last = endMark.current;
    if (!root || !first || !last || typeof IntersectionObserver === 'undefined') return;
    // rootMargin: sub-pixel widths can leave a marker a fraction of a pixel short of fully visible.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, intersectionRatio } of entries) {
          const more = intersectionRatio < 1;
          setEdges((e) => (target === first ? { ...e, start: more } : { ...e, end: more }));
        }
      },
      { root, threshold: 1, rootMargin: '1px' },
    );
    observer.observe(first);
    observer.observe(last);
    return () => observer.disconnect();
  }, []);
  const start = edges.start ? 'transparent, black 32px' : 'black, black 32px';
  const end = edges.end ? 'black calc(100% - 32px), transparent' : 'black calc(100% - 32px), black';
  const mask = `linear-gradient(to right, ${start}, ${end})`;
  const scroll = (dir: -1 | 1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' });
  };
  // Out of the tab order: every item in the row can be reached with Tab anyway.
  const chevron = (dir: -1 | 1) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={dir < 0 ? t.weldboard.editor.scrollBack : t.weldboard.editor.scrollMore}
      title={dir < 0 ? t.weldboard.editor.scrollBack : t.weldboard.editor.scrollMore}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => scroll(dir)}
      className={cn(
        'absolute top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-foreground [&_svg]:size-3.5',
        dir < 0 ? 'left-0' : 'right-0',
      )}
    >
      {dir < 0 ? <ChevronLeft /> : <ChevronRight />}
    </button>
  );
  return (
    <div className={cn('relative flex min-w-0', outerClassName)}>
      <div
        ref={ref}
        className={cn('flex min-w-0 flex-1 items-center overflow-x-auto scroll-px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
        style={edges.start || edges.end ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        <span ref={startMark} aria-hidden className="w-px shrink-0 self-stretch" />
        {children}
        <span ref={endMark} aria-hidden className="w-px shrink-0 self-stretch" />
      </div>
      {edges.start && chevron(-1)}
      {edges.end && chevron(1)}
    </div>
  );
}
