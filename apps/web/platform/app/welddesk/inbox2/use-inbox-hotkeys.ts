import { useEffect } from 'react';

interface InboxHotkeysOptions {
  /** Only active when a conversation is open (A/Z/Shift+C need one). */
  hasConversation: boolean;
  onAssign: () => void;
  onSnooze: () => void;
  onToggleClose: () => void;
  onCommandBar: () => void;
  onEscapeToList?: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * No shared hotkey utility exists in the platform (confirmed — only inline
 * page-local keydown listeners, e.g. components/layout/app-header.tsx's
 * Cmd+K handler). This mirrors that pattern, scoped to the inbox pages:
 * A assign, Z snooze, Shift+C close/reopen, Cmd/Ctrl+Enter send (composer
 * handles this one directly — see composer.tsx), Esc back to list on mobile,
 * Cmd/Ctrl+K opens the local command bar.
 */
export function useInboxHotkeys({
  hasConversation,
  onAssign,
  onSnooze,
  onToggleClose,
  onCommandBar,
  onEscapeToList,
}: InboxHotkeysOptions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onCommandBar();
        return;
      }

      if (isTypingTarget(e.target)) return;

      if (!hasConversation) return;

      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        onAssign();
        return;
      }
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        onSnooze();
        return;
      }
      if (e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        onToggleClose();
        return;
      }
      if (e.key === 'Escape') {
        onEscapeToList?.();
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [hasConversation, onAssign, onSnooze, onToggleClose, onCommandBar, onEscapeToList]);
}
