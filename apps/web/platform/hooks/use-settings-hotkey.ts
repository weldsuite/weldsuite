import { useEffect } from "react";
import { HOTKEYS, matchesHotkey } from "@/lib/hotkeys/registry";

export function useSettingsHotkey(onOpen: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Cmd+, (Mac) or Ctrl+, (Windows/Linux) to open settings, unless an
      // editor already used the key (subscript in WeldDocs).
      if (!event.defaultPrevented && matchesHotkey(event, HOTKEYS.openSettings)) {
        event.preventDefault();
        onOpen();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpen]);
}
