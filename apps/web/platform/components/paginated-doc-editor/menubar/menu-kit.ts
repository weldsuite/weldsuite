import { useCallback, useLayoutEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';

// ---------------------------------------------------------------------------
// Shared types + helpers for the standalone paginated editor's Google-Docs-
// style menu bar. Unlike the legacy BlockNote menubar, every command here is
// expressed against a plain `contenteditable` via `document.execCommand`
// (the same API the editor's inline toolbar uses), surfaced through the
// `DocCommand` object the editor hands down.
// ---------------------------------------------------------------------------

/** Editor commands the menu bar drives. All operate on the contenteditable. */
export interface DocCommand {
  /** Run a `document.execCommand` against the editor (restores selection first). */
  exec: (command: string, value?: string) => void;
  /** Set the current block's tag via `formatBlock` (P, H1..H3, BLOCKQUOTE, PRE). */
  setBlock: (tag: string) => void;
  /** Prompt for a URL and link the current selection. */
  insertLink: () => void;
  /** Insert plain text at the caret. */
  insertText: (text: string) => void;
  /** Open the browser print dialog (the print CSS lays pages out correctly). */
  print: () => void;
  /** Download the current document as a standalone `.html` file. */
  downloadHtml: () => void;
  /** Toggle native browser full screen. */
  toggleFullscreen: () => void;
}

/**
 * Optional document-level callbacks. The standalone editor doesn't own a
 * `DocumentSource`, so a host page can wire these (rename/delete/save-now)
 * when it has them; menu items fall back to a "coming soon" toast otherwise.
 */
export interface DocActions {
  fileName?: string;
  onRename?: () => void;
  onDelete?: () => void;
  onSaveNow?: () => void;
}

export interface MenuProps {
  cmd: DocCommand;
  actions?: DocActions;
  /** Stable id this menu owns inside the Menubar (e.g. "file"). */
  menuValue: string;
  editable: boolean;
}

/**
 * Returns a factory producing "coming soon" toast handlers, so menu items for
 * features we haven't built yet announce themselves specifically rather than
 * silently doing nothing.
 */
export function useStub() {
  const t = useTranslations();
  return useCallback(
    (label: string) => () => {
      toast(t('sweep.entities.comingSoonToast', { label }));
    },
    [t],
  );
}

const ESTIMATED_MENU_WIDTH_PX = 240;
const COLLISION_PADDING_PX = 8;

/**
 * Picks `align="start"` by default; flips to `align="end"` if the menu would
 * overflow the right edge of the viewport when opened from this trigger. The
 * decision is independent of open/close state, so it never races Radix's
 * Menubar state machine.
 */
export function useMenuAlign(menuValue: string): 'start' | 'end' {
  const [align, setAlign] = useState<'start' | 'end'>('start');

  useLayoutEffect(() => {
    const compute = () => {
      const trigger = document.querySelector(
        `[data-menu-value="${menuValue}"]`,
      ) as HTMLElement | null;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const overflow =
        rect.left + ESTIMATED_MENU_WIDTH_PX > window.innerWidth - COLLISION_PADDING_PX;
      setAlign(overflow ? 'end' : 'start');
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [menuValue]);

  return align;
}
