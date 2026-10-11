import React, { useEffect, useRef } from 'react';

/** How long a click on a link waits for a second click before it opens. */
export const LINK_OPEN_DELAY_MS = 250;

/**
 * The address a cell's link opens, or null when the value is not one to link
 * to. A bare domain gets `https://`; any scheme other than http(s) is refused,
 * so a stored `javascript:` value can never become a clickable link.
 */
export function toHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  return `https://${trimmed}`;
}

interface UrlLinkProps {
  href: string;
  children: React.ReactNode;
  /** Runs on a double click, in place of opening the link. */
  onEdit: () => void;
}

/**
 * A link in a grid cell: one click opens it in a new tab, a double click
 * edits the cell. The open waits a moment so that the first click of a double
 * click does not already send the user away.
 */
export function UrlLink({ href, children, onEdit }: Readonly<UrlLinkProps>) {
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(openTimer.current), []);

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // The cell behind the link edits on click; a click on the link must not.
    e.stopPropagation();
    // Cmd / Ctrl / Shift click: leave the browser's own new-tab and
    // new-window behaviour alone.
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    clearTimeout(openTimer.current);
    if (e.detail > 1) {
      onEdit();
      return;
    }
    openTimer.current = setTimeout(() => {
      window.open(href, '_blank', 'noopener,noreferrer');
    }, LINK_OPEN_DELAY_MS);
  };

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // A draggable link would start a native drag in place of the grid's
      // own drag to select a range of cells.
      draggable={false}
      onClick={handleClick}
      className="relative z-[1] min-w-0 truncate text-[14px] text-blue-600 dark:text-blue-400 underline"
    >
      {children}
    </a>
  );
}
