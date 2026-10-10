import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDocumentHtml, putDocumentHtml } from './api';

export type HtmlDocSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * Load + debounced-save the HTML content of a document for the standalone
 * paginated editor. Returns the initial HTML (null while loading), a
 * `save(html)` to call on every change, and the current save `status`. Flushes a pending save on unmount.
 */
export function useHtmlDoc(fileId: string) {
  const [html, setHtml] = useState<string | null>(null);
  const [status, setStatus] = useState<HtmlDocSaveStatus>('idle');
  const latest = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileIdRef = useRef(fileId);
  useEffect(() => {
    fileIdRef.current = fileId;
  }, [fileId]);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setStatus('idle');
    latest.current = null;
    fetchDocumentHtml(fileId)
      .then((h) => {
        if (!cancelled) setHtml(h);
      })
      .catch(() => {
        if (!cancelled) setHtml('');
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const persist = useCallback((next: string, trackStatus: boolean) => {
    if (trackStatus) setStatus('saving');
    return putDocumentHtml(fileIdRef.current, next)
      .then(() => {
        if (trackStatus && latest.current === next) setStatus('saved');
      })
      .catch(() => {
        if (trackStatus) setStatus('error');
      });
  }, []);

  // Unmount flush doesn't update status (the component is going away).
  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (latest.current !== null) {
      void persist(latest.current, false);
    }
  }, [persist]);

  const save = useCallback((next: string) => {
    latest.current = next;
    setStatus('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void persist(next, true);
    }, 1200);
  }, [persist]);

  // Flush a pending save when leaving the document.
  useEffect(() => () => flush(), [fileId, flush]);

  return { html, save, status };
}
