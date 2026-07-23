import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDocumentHtml, putDocumentHtml } from './api';

/**
 * Load + debounced-save the HTML content of a document for the standalone
 * paginated editor. Returns the initial HTML (null while loading) and a
 * `save(html)` to call on every change. Flushes a pending save on unmount.
 */
export function useHtmlDoc(fileId: string) {
  const [html, setHtml] = useState<string | null>(null);
  const latest = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileIdRef = useRef(fileId);
  useEffect(() => {
    fileIdRef.current = fileId;
  }, [fileId]);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
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

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (latest.current !== null) {
      void putDocumentHtml(fileIdRef.current, latest.current).catch(() => {});
    }
  }, []);

  const save = useCallback((next: string) => {
    latest.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void putDocumentHtml(fileIdRef.current, next).catch(() => {});
    }, 1200);
  }, []);

  // Flush a pending save when leaving the document.
  useEffect(() => () => flush(), [fileId, flush]);

  return { html, save };
}
