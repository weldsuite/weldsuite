import { useEffect } from "react";
import { HOTKEYS, isTypingTarget, matchesBinding } from "@/lib/hotkeys/registry";

/**
 * Cmd/Ctrl+/ or `?` opens the keyboard shortcuts page. The bare `?` is left
 * alone while the user is typing, so it can still be typed.
 */
export function useShortcutsHotkey(onOpen: () => void) {
  useEffect(() => {
    const { binding, alternate } = HOTKEYS.showKeyboardShortcuts;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const viaModifier = matchesBinding(event, binding);
      const viaQuestionMark = alternate ? matchesBinding(event, alternate) && !isTypingTarget(event.target) : false;
      if (!viaModifier && !viaQuestionMark) return;
      event.preventDefault();
      onOpen();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpen]);
}
