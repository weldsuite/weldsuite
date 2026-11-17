/**
 * Starts a page's own "new" flow when the URL asks for it with `?new=1`: the
 * command palette's Create actions and the onboarding checklist link to a
 * module page that way, so the flow runs inside that module (its providers,
 * its permission scope, its `X-Weld-App`). The parameter is dropped first, so
 * a reload or Back doesn't start it again.
 */

import { useEffect, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

/** The query string a Create link adds to a module page. */
export const CREATE_INTENT_PARAM = 'new';

/** `href` with `?new=<kind>` (or `&new=<kind>`) appended. */
export function withCreateIntent(href: string, kind = '1'): string {
  return `${href}${href.includes('?') ? '&' : '?'}${CREATE_INTENT_PARAM}=${encodeURIComponent(kind)}`;
}

export interface CreateIntentOptions {
  /**
   * Holds the flow back until the page can run it (permissions or data still
   * loading); the parameter stays in the URL until then.
   */
  ready?: boolean;
  /**
   * Which flow, for a page with more than one (`?new=channel`, `?new=dm`).
   * Defaults to `1`.
   */
  kind?: string;
}

/** Calls `onCreate` once each time the page is opened with `?new=<kind>`. */
export function useCreateIntent(onCreate: () => void, options: CreateIntentOptions = {}): void {
  const { ready = true, kind = '1' } = options;
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const wanted = String(search[CREATE_INTENT_PARAM] ?? '') === kind;
  const onCreateRef = useRef(onCreate);
  onCreateRef.current = onCreate;
  // Survives StrictMode's effect replay, so one link starts one flow.
  const handled = useRef(false);

  useEffect(() => {
    if (!wanted) {
      handled.current = false;
      return;
    }
    if (!ready || handled.current) return;
    handled.current = true;
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, [CREATE_INTENT_PARAM]: undefined }),
      replace: true,
    });
    onCreateRef.current();
  }, [wanted, ready, navigate]);
}
