/**
 * A preview of its children in a theme and at a width of its own: a
 * same-origin iframe the React tree is portalled into, with the app's
 * stylesheets copied in and `dark` (or not) on its `<html>`. That keeps the
 * app's global dark mode untouched and makes width-based styles react to the
 * frame, not the window. Vite's dev styles change at runtime, so the copy
 * follows `document.head`.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

const COPIED = 'data-preview-copy';

/** The frame's own document: empty, and in standards mode (it has a doctype). */
const FRAME_DOCUMENT = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

function copyStyles(target: Document): void {
  for (const node of Array.from(target.head.querySelectorAll(`[${COPIED}]`))) node.remove();
  for (const node of Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'))) {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.setAttribute(COPIED, '');
    target.head.appendChild(copy);
  }
}

interface ThemedFrameProps {
  theme: 'light' | 'dark';
  width: number;
  title: string;
  children: ReactNode;
  className?: string;
}

export function ThemedFrame({ theme, width, title, children, className }: Readonly<ThemedFrameProps>) {
  // The frame's document, once its `srcdoc` has loaded.
  const [doc, setDoc] = useState<Document | null>(null);
  // Where the children go: a node of our own in the frame's body, so the
  // portal can always take its content out again, even once the frame is gone.
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(160);

  // Set the frame's document up: the app's styles, root classes and a node for the portal.
  useEffect(() => {
    if (!doc) return;
    copyStyles(doc);
    // The app's root classes (fonts, text size) and inline variables, minus its own theme.
    const root = document.documentElement;
    doc.documentElement.className = root.className.replace(/\b(dark|light)\b/g, '').trim();
    const inline = root.getAttribute('style');
    if (inline) doc.documentElement.setAttribute('style', inline);
    doc.documentElement.lang = root.lang;
    doc.body.className = 'bg-background text-foreground antialiased';
    doc.body.style.margin = '0';
    // The frame grows with its content (below); it never scrolls itself.
    doc.documentElement.style.overflow = 'hidden';
    const node = doc.createElement('div');
    doc.body.appendChild(node);
    setMount(node);

    let pending = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => copyStyles(doc));
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(pending);
      observer.disconnect();
      node.remove();
    };
  }, [doc]);

  useEffect(() => {
    const doc = mount?.ownerDocument;
    if (!doc) return;
    doc.documentElement.classList.toggle('dark', theme === 'dark');
    doc.documentElement.style.colorScheme = theme;
  }, [mount, theme]);

  // The frame is as tall as what it shows.
  useEffect(() => {
    if (!mount) return;
    const observer = new ResizeObserver(() => setHeight(Math.max(80, Math.ceil(mount.scrollHeight))));
    observer.observe(mount);
    return () => observer.disconnect();
  }, [mount]);

  return (
    <>
      <iframe
        srcDoc={FRAME_DOCUMENT}
        onLoad={(event) => setDoc(event.currentTarget.contentDocument)}
        title={title}
        style={{ width, height }}
        className={cn('block shrink-0 rounded-lg border bg-background', className)}
      />
      {mount && createPortal(<div className="p-3">{children}</div>, mount)}
    </>
  );
}
