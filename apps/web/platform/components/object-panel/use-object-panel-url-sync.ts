/**
 * Two-way sync between the global object-panel stack and the `?stack=` URL
 * query param.
 *
 * Mount once per page surface that wants URL deep-linking (e.g. inside
 * `customers-grid.tsx`). The hook will:
 *   1. On mount and whenever the URL changes, parse `?stack=` and write it
 *      into the atom (if it differs from the current atom).
 *   2. On atom changes, serialize the stack and replace the URL (if the
 *      serialized form differs from the current `?stack=`).
 *
 * Different pages can each call this hook with their own base path (e.g.
 * `/weldcrm/customers`) — only the `stack` param is touched, other params
 * are preserved.
 */

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from '@/lib/router';
import { useObjectPanel } from './use-object-panel';
import { serializeStack, parseStack, stacksEqual } from './stack-url';

export function useObjectPanelUrlSync(basePath: string) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { stack, replaceStack } = useObjectPanel();

  // Keep a ref to the most recently applied serialized value so we don't
  // ping-pong between the URL and the atom when one of them triggers the
  // other.
  const lastSerialized = useRef<string>('');

  const raw = searchParams.get('stack') ?? '';

  // URL → atom
  useEffect(() => {
    if (raw === lastSerialized.current) return;
    const parsed = parseStack(raw);
    if (!stacksEqual(parsed, stack)) {
      lastSerialized.current = raw;
      replaceStack(parsed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  // Atom → URL
  useEffect(() => {
    // The hook is page-scoped via `basePath`. Once the user navigates
    // somewhere else (a different module, a nested route, a non-matching
    // path), the hook is no longer the URL's owner — replacing back to
    // `basePath` here would clobber the in-flight navigation. The first
    // pathname tick after navigation already differs from basePath, so we
    // bail before touching the URL.
    if (pathname !== basePath) return;

    const serialized = serializeStack(stack);
    if (serialized === raw) return;
    lastSerialized.current = serialized;
    const params = new URLSearchParams(searchParams.toString());
    if (serialized) params.set('stack', serialized);
    else params.delete('stack');
    const query = params.toString();
    router.replace(`${basePath}${query ? `?${query}` : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stack, pathname]);
}
