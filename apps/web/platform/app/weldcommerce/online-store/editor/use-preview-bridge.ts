/**
 * The editor's side of the preview: asks the API for a preview link (renewed
 * before it expires), keeps the iframe's ref, listens for the renderer's
 * `ready` and `select` messages from that iframe and origin only, and sends
 * `refresh`, `highlight` and `navigate` to that origin only (`./lib/bridge`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCreatePreviewLink, type PreviewLink } from '@/hooks/queries/use-online-store-queries';
import { previewOrigin, readPreviewMessage, sendToPreview, type EditorMessage, type PreviewMessage } from '../lib/bridge';

export type PreviewState = 'idle' | 'loading' | 'ready' | 'error';

/** Renew the link this long before it expires, and never sooner than `MIN_RENEW_MS` from now. */
const RENEW_EARLY_MS = 60_000;
const MIN_RENEW_MS = 30_000;

export function usePreviewBridge({
  siteId,
  enabled,
  onMessage,
}: Readonly<{ siteId: string; enabled: boolean; onMessage: (message: PreviewMessage) => void }>) {
  const { mutateAsync: createLink } = useCreatePreviewLink();
  const [link, setLink] = useState<PreviewLink | null>(null);
  const [state, setState] = useState<PreviewState>('idle');
  const frameRef = useRef<HTMLIFrameElement>(null);
  const origin = previewOrigin(link?.url);
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  });

  const open = useCallback(async () => {
    setState('loading');
    try {
      const res = await createLink(siteId);
      if (!previewOrigin(res.data.url)) throw new Error('The preview link is not an http(s) address.');
      setLink(res.data);
    } catch {
      setLink(null);
      setState('error');
    }
  }, [createLink, siteId]);

  useEffect(() => {
    if (enabled) void open();
  }, [enabled, open]);

  useEffect(() => {
    if (!link) return;
    const expires = Date.parse(link.expiresAt);
    if (!Number.isFinite(expires)) return;
    const timer = setTimeout(() => void open(), Math.max(expires - Date.now() - RENEW_EARLY_MS, MIN_RENEW_MS));
    return () => clearTimeout(timer);
  }, [link, open]);

  useEffect(() => {
    if (!origin) return;
    const listener = (event: MessageEvent) => {
      const message = readPreviewMessage(event, { origin, source: frameRef.current?.contentWindow ?? null });
      if (!message) return;
      if (message.type === 'ready') setState('ready');
      onMessageRef.current(message);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [origin]);

  const send = useCallback((message: EditorMessage) => sendToPreview(frameRef.current?.contentWindow, origin, message), [origin]);

  return { frameRef, url: link?.url ?? null, origin, state, reload: open, send };
}
