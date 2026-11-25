/**
 * Clickjacking defences for the extension pages framed into web pages
 * (ADR PASS-009): an action counts only when
 *
 * 1. it is a trusted event (a person, not a script), inside this frame;
 * 2. the frame is actually visible: IntersectionObserver v2 `trackVisibility`
 *    says it is fully on screen, not covered by anything, and not faded,
 *    filtered or transformed by the page around it;
 * 3. it has been visible for at least 500 ms, so a page can't slide it under
 *    the pointer just before a click.
 *
 * A browser without `trackVisibility` gets no clickable menu: refusing is the
 * safe answer.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export const CLICK_DELAY_MS = 500;

interface VisibilityEntry extends IntersectionObserverEntry {
  isVisible?: boolean;
}

export function supportsTrackVisibility(): boolean {
  return typeof IntersectionObserverEntry !== 'undefined' && 'isVisible' in IntersectionObserverEntry.prototype;
}

/** Pure: whether an action at `now` is accepted. */
export function acceptAction(input: { trusted: boolean; visibleSince: number | null; now: number }): boolean {
  return input.trusted && input.visibleSince !== null && input.now - input.visibleSince >= CLICK_DELAY_MS;
}

export function useClickGuard(target: RefObject<HTMLElement | null>): {
  /** Buttons may look enabled: visible long enough. */
  armed: boolean;
  /** Call first in every handler that acts; false means ignore the event. */
  accept: (event: { isTrusted: boolean }) => boolean;
} {
  const visibleSince = useRef<number | null>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const element = target.current;
    if (!element || !supportsTrackVisibility()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1) as VisibilityEntry | undefined;
        const visible = Boolean(entry?.isIntersecting && entry.isVisible);
        clearTimeout(timer);
        if (!visible) {
          visibleSince.current = null;
          setArmed(false);
          return;
        }
        visibleSince.current ??= performance.now();
        timer = setTimeout(() => setArmed(true), CLICK_DELAY_MS);
      },
      // `trackVisibility` needs a `delay` of at least 100 ms.
      { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
    );
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [target]);

  const accept = useCallback(
    (event: { isTrusted: boolean }) =>
      acceptAction({ trusted: event.isTrusted, visibleSince: visibleSince.current, now: performance.now() }),
    [],
  );
  return { armed, accept };
}

/** Where each key moves focus, from the current index in a list of `count`. */
const MOVES: Record<string, (current: number, count: number) => number> = {
  Home: () => 0,
  End: (_, count) => count - 1,
  ArrowDown: (current, count) => (current + 1) % count,
  ArrowUp: (current, count) => (current - 1 + count) % count,
};

/** Arrow keys, Home and End between the buttons of a list. */
export function moveFocus(
  event: { key: string; preventDefault: () => void },
  container: HTMLElement | null,
): void {
  const move = Object.hasOwn(MOVES, event.key) ? MOVES[event.key] : undefined;
  if (!container || !move) return;
  const items = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-item]:not([disabled])'));
  if (items.length === 0) return;
  const current = items.indexOf(container.ownerDocument.activeElement as HTMLButtonElement);
  event.preventDefault();
  items[move(current, items.length)]?.focus();
}
