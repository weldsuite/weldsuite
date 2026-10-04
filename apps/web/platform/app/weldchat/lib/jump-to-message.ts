/**
 * Scroll-to-and-highlight helpers for message deep links (`?msg=<messageId>`).
 *
 * The message row carries `data-message-id`; the highlight is the
 * `pinned-highlight` class (same flash the pinned bar and system chips use).
 */

const HIGHLIGHT_CLASS = 'pinned-highlight';
const HIGHLIGHT_MS = 1000;

/** Looks the id up by attribute value (no selector building, so a URL-supplied id can't break out). */
export function findMessageElement(messageId: string): HTMLElement | null {
  const rows = document.querySelectorAll<HTMLElement>('[data-message-id]');
  for (const row of rows) {
    if (row.getAttribute('data-message-id') === messageId) return row;
  }
  return null;
}

/** Scroll the message into view and flash it. Returns false when it isn't rendered. */
export function flashMessage(messageId: string): boolean {
  const el = findMessageElement(messageId);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
  return true;
}

/**
 * Like {@link flashMessage}, but retries while the row is still mounting
 * (e.g. a thread pane that is loading its replies). Returns a cancel function.
 */
export function flashMessageWhenMounted(messageId: string, attempts = 20, intervalMs = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const tick = (remaining: number) => {
    if (cancelled) return;
    if (flashMessage(messageId) || remaining <= 0) return;
    timer = setTimeout(() => tick(remaining - 1), intervalMs);
  };
  tick(attempts);

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
