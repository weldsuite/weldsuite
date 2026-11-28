/**
 * A ResizeObserver for jsdom, which has none. It never fires on its own: a
 * test calls `resizeAll()` after changing the size jsdom reports.
 */
export const resizeObservers = new Set<FakeResizeObserver>();

export class FakeResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    resizeObservers.delete(this);
  }

  /** Report every observed element as resized. */
  fire(): void {
    if (this.targets.size === 0) return;
    const entries = [...this.targets].map((target) => ({ target }) as ResizeObserverEntry);
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

/** Tell every live observer its elements changed size. */
export function resizeAll(): void {
  for (const observer of resizeObservers) observer.fire();
}
