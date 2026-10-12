/**
 * The dock in the bottom-right corner where floating things sit once they are
 * minimized: one column, with a group per kind of thing (notes above mails),
 * each made of `MinimizedDockButton`s.
 *
 * The kinds are rendered by unrelated parts of the app (`GlobalPinnedNote`,
 * `FloatingComposePanel`), so the column is one shared element on `<body>` and
 * each kind portals its group into it. Laid out by the browser, a group that
 * grows (a stack of mails fanning out on hover) simply pushes the one above
 * it up; nothing has to know another group's height.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { usePathname } from '@/lib/router';
import { cn } from '@/lib/utils';
import { minimizedDockRight } from './minimized-dock-button';

const HOST_ID = 'minimized-dock';
// `pointer-events-none`: the column's gaps must not swallow clicks meant for
// the page; the groups switch them back on.
const HOST_CLASS = 'fixed bottom-3 z-50 flex flex-col items-end gap-2 pointer-events-none';

/** Top to bottom. Mails keep the corner they have always had. */
const GROUP_ORDER = { note: 1, mail: 2 } as const;
export type MinimizedDockKind = keyof typeof GROUP_ORDER;

// Which kinds have something docked right now.
const docked = new Map<MinimizedDockKind, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isOccupied(): boolean {
  return docked.size > 0;
}

function getHost(): HTMLElement {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.className = HOST_CLASS;
    host.dataset.testid = 'minimized-dock';
    document.body.appendChild(host);
  }
  return host;
}

/** The full-page mail compose keeps its Send button in that corner, so the dock stays out of it. */
export function useMinimizedDockAllowed(): boolean {
  return !/\/compose\/?$/.test(usePathname());
}

/**
 * True while anything is docked: an open floating panel (the mail compose,
 * the pinned note) then sits beside the dock instead of on top of it.
 */
export function useMinimizedDockOccupied(): boolean {
  return useSyncExternalStore(subscribe, isOccupied, isOccupied);
}

/** One kind's group in the dock. Render it only while that kind has something minimized. */
export function MinimizedDockGroup({
  kind,
  children,
  testId,
}: Readonly<{ kind: MinimizedDockKind; children: ReactNode; testId?: string }>) {
  const mobileNav = useMobileNavOptional();
  const right = minimizedDockRight(mobileNav);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(getHost());
  }, []);

  useEffect(() => {
    if (host) host.style.right = right;
  }, [host, right]);

  useEffect(() => {
    docked.set(kind, (docked.get(kind) ?? 0) + 1);
    emit();
    return () => {
      const left = (docked.get(kind) ?? 1) - 1;
      if (left > 0) docked.set(kind, left);
      else docked.delete(kind);
      emit();
    };
  }, [kind]);

  if (!host) return null;
  return createPortal(
    // `group/stack`: the buttons of one kind tuck behind one another until
    // that group is hovered.
    <div
      className={cn('group/stack pointer-events-auto flex flex-col items-end')}
      style={{ order: GROUP_ORDER[kind] }}
      data-testid={testId}
    >
      {children}
    </div>,
    host,
  );
}
