import { useCallback, useEffect, useState } from 'react';
import { onStateChanged, request } from '../lib/messaging';
import type { ExtensionState } from '../lib/protocol';

/** The worker's view of server, person and workspace; refreshed when it says something changed. */
export function useExtensionState(): {
  state: ExtensionState | null | undefined;
  reload: () => void;
  setState: (state: ExtensionState) => void;
} {
  const [state, setState] = useState<ExtensionState | null | undefined>(undefined);

  const reload = useCallback(() => {
    request({ type: 'state:get' }).then(setState, () => setState(null));
  }, []);

  useEffect(() => {
    reload();
    return onStateChanged(reload);
  }, [reload]);

  return { state, reload, setState };
}

/** Open an extension page (settings) or the web app in a new tab. */
export function openPage(path: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}
