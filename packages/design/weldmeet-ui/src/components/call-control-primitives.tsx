import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@weldsuite/ui/lib/utils';

// The building blocks of the call control buttons, shared by the meeting
// controls bar and other call screens (WeldCall) so they look and behave alike.

// ─── Tooltip ─────────────────────────────────────────────────────────────────

export function CallTooltip({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovering = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const hasOpenDropdown = useCallback(() => {
    return !!triggerRef.current?.querySelector('[data-state="open"]');
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    if (!hovering.current || hasOpenDropdown()) return;
    timerRef.current = setTimeout(() => {
      if (!hovering.current || hasOpenDropdown()) return;
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setPos({ x: rect.left + rect.width / 2, y: rect.top - 8 });
      }
      setShow(true);
    }, 600);
  }, [clearTimer, hasOpenDropdown]);

  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (hasOpenDropdown()) {
        clearTimer();
        setShow(false);
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['data-state'], subtree: true });
    return () => observer.disconnect();
  }, [clearTimer, hasOpenDropdown]);

  return (
    // Hover wrapper for the tooltip only; the control inside is the interactive element.
    <div
      ref={triggerRef}
      role="presentation"
      onMouseEnter={() => { hovering.current = true; startTimer(); }}
      onMouseLeave={() => { hovering.current = false; clearTimer(); setShow(false); }}
      onMouseDown={() => { clearTimer(); setShow(false); }}
    >
      {children}
      {createPortal(
        <div
          className="fixed px-2 py-1 bg-primary text-primary-foreground text-[11px] rounded-md whitespace-nowrap pointer-events-none z-[9999] -translate-x-1/2 -translate-y-full transition-opacity duration-150"
          style={{ left: pos.x, top: pos.y, opacity: show ? 1 : 0 }}
        >
          {label}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Bar ─────────────────────────────────────────────────────────────────────

/** The strip along the bottom of a call that holds its controls. */
export const CALL_CONTROLS_BAR_CLASSES =
  'flex items-center justify-center gap-2 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:gap-3 md:p-4 bg-background/80 backdrop-blur';

// ─── Button states ───────────────────────────────────────────────────────────

// The icon buttons and dropdown arrows keep a flat background on hover;
// IconHighlight / ArrowChevron draw the highlight as a rounded square around
// the icon (also shown while the button's menu / popover is open) instead.
export const OFF_STATE_CLASSES =
  'bg-red-100 hover:bg-red-100 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/20 dark:text-red-400';

/** A control that is shown but not usable: it keeps its tooltip, so it is
 *  `aria-disabled` rather than `disabled`. */
export const DISABLED_CONTROL_CLASSES = 'opacity-50 cursor-not-allowed hover:bg-secondary';

export type HighlightTone = 'default' | 'off' | 'active';

const ICON_HIGHLIGHT_CLASSES: Record<HighlightTone, string> = {
  default: 'group-hover/icon:bg-foreground/10 group-data-[state=open]/icon:bg-foreground/10',
  off: 'group-hover/icon:bg-red-200 group-data-[state=open]/icon:bg-red-200 dark:group-hover/icon:bg-red-500/20 dark:group-data-[state=open]/icon:bg-red-500/20',
  active: 'group-hover/icon:bg-primary-foreground/15 group-data-[state=open]/icon:bg-primary-foreground/15',
};

/** Wraps the icon of a `group/icon` button. `fill` highlights the whole
 *  button instead of a square around the icon. */
export function IconHighlight({ tone, fill, children }: Readonly<{ tone: HighlightTone; fill?: boolean; children: React.ReactNode }>) {
  return (
    <span className={cn("flex items-center justify-center transition-colors", fill ? "h-full w-full" : "h-8 w-8 rounded-lg", ICON_HIGHLIGHT_CLASSES[tone])}>
      {children}
    </span>
  );
}
