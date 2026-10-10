/**
 * Keeps the WeldFlow object-panel stack and the `?stack=` URL param in sync on
 * whatever WeldFlow page is showing, so an open task has a shareable URL:
 *
 *   /weldflow/project/{id}/tasks?stack=task:{taskId}:panel
 *
 * - Opening a task writes the param (a new history entry, so Back closes the
 *   panel again); closing it removes the param.
 * - Loading or navigating to a URL that carries the param opens that panel.
 * - Switching to another page drops the param together with the panel (the
 *   object-panel host closes the stack on every pathname change).
 *
 * This is the same wire format the CRM lists use via `useObjectPanelUrlSync`.
 * That hook is bound to one fixed base path; WeldFlow shows tasks on many pages
 * (tasks, list, pipeline, gantt, my tasks), so this variant follows the current
 * path instead and takes care to never write a stale stack into a new page's URL.
 */

import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from '@/lib/router';
import { withQuery } from '@/lib/with-query';
import { useObjectPanel } from '@/components/object-panel';
import { parseStack, serializeStack, stacksEqual } from '@/components/object-panel/stack-url';

export function useTaskPanelUrlSync() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { stack, replaceStack } = useObjectPanel();

  const raw = searchParams.get('stack') ?? '';

  // The `?stack=` value the URL and the atom were last reconciled on.
  const reconciledRef = useRef<string | null>(null);
  // Set while a URL → atom update is in flight: the atom value this effect pass
  // still sees is stale until the next render, and must not be written back.
  const pendingFromUrlRef = useRef<string | null>(null);

  // URL → atom
  useEffect(() => {
    if (reconciledRef.current === raw) return;
    reconciledRef.current = raw;
    const parsed = parseStack(raw);
    if (stacksEqual(parsed, stack)) return;
    pendingFromUrlRef.current = serializeStack(parsed);
    replaceStack(parsed);
    // Only the URL value is a trigger here; `stack` is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  // Atom → URL
  useEffect(() => {
    const serialized = serializeStack(stack);
    if (pendingFromUrlRef.current !== null) {
      // Wait until the atom has caught up with the URL we just applied.
      if (serialized === pendingFromUrlRef.current) pendingFromUrlRef.current = null;
      return;
    }
    if (reconciledRef.current === null) return;
    if (serialized === reconciledRef.current) return;

    const params = new URLSearchParams(searchParams.toString());
    if (serialized) params.set('stack', serialized);
    else params.delete('stack');

    const opening = reconciledRef.current === '' && serialized !== '';
    reconciledRef.current = serialized;
    const href = withQuery(pathname, params.toString());
    if (opening) router.push(href);
    else router.replace(href);
    // `searchParams`/`pathname` are read at write time; re-running on them
    // would re-send the same href.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stack]);
}
