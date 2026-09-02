/**
 * Renders an email body.
 *
 * HTML mail is rendered inside a sandboxed iframe with no `allow-scripts`, so
 * even though bodies are already sanitized server-side (at ingest in the
 * inbound worker, and on send in personal-api), nothing in a message can reach
 * the host page — no script, no form post, no top-level navigation. The iframe
 * is resized to its content so the mail scrolls with the page rather than in a
 * nested scrollbar.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const FRAME_STYLES = `
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      font: 14px/1.6 Inter, system-ui, -apple-system, sans-serif;
      color: #18181b;
      word-break: break-word;
overflow-wrap: anywhere;
    }
    img, table { max-width: 100%; }
    img { height: auto; }
    a { color: #2563eb; }
    blockquote {
      margin: 0.5em 0;
      padding-left: 1em;
      border-left: 2px solid #e4e4e7;
      color: #52525b;
    }
    pre { white-space: pre-wrap; }
  </style>
`;

export function MessageBody({
  htmlBody,
  textBody,
}: {
  htmlBody?: string | null;
  textBody?: string | null;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);

  // Grow the frame to fit its content. Re-measured on load and whenever late
  // resources (images) change the layout.
  const measure = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.body) return;
    const next = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
    if (next > 0) setHeight(next + 8);
  }, []);

  useEffect(() => {
    if (!htmlBody) return;
    const timers = [50, 300, 1000].map((ms) => window.setTimeout(measure, ms));
    return () => timers.forEach(window.clearTimeout);
  }, [htmlBody, measure]);

  if (htmlBody) {
    return (
      <iframe
        ref={frameRef}
        onLoad={measure}
        title="Message body"
        // No `allow-scripts`: the frame can render markup and load images but
        // cannot execute anything or navigate the parent.
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={`<!doctype html><html><head><meta charset="utf-8">${FRAME_STYLES}</head><body>${htmlBody}</body></html>`}
        className="w-full border-0 bg-white"
        style={{ height }}
      />
    );
  }

  const text = textBody?.trim();
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
      {text || '(empty message)'}
    </div>
  );
}
