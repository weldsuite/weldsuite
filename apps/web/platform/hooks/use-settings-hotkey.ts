
import { useEffect } from "react";

export function useSettingsHotkey(onOpen: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ctrl+, (Windows/Linux) or Cmd+, (Mac) to open settings
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        onOpen();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpen]);
}
