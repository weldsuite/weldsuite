/**
 * The `chrome.*` side of the popup: the active tab, and running the page agent
 * in it. Everything here works on the `activeTab` grant the browser gives when
 * the user opens the popup — there is no host permission for web pages.
 */

import { pageAgent, type PageCommand, type PageResult } from '../page/page-agent';
import type { PagePort } from './actions';

export interface ActiveTab {
  id: number;
  url: string | null;
}

function hasExtensionApis(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.tabs) && Boolean(chrome.scripting);
}

export async function getActiveTab(): Promise<ActiveTab | null> {
  if (!hasExtensionApis()) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return null;
  return { id: tab.id, url: tab.url ?? null };
}

export function openTab(url: string): void {
  if (typeof chrome !== 'undefined' && chrome.tabs) void chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}

export const chromePage: PagePort = {
  async currentUrl(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      // Without the activeTab grant (the tab navigated to another origin) there is no URL.
      return tab.url ?? null;
    } catch {
      // The tab was closed.
      return null;
    }
  },

  async run(tabId, command) {
    // Top frame only: `allFrames` is left off on purpose, so a login is never
    // put into an embedded third-party frame.
    const [injection] = await chrome.scripting.executeScript<[PageCommand], PageResult>({
      target: { tabId },
      func: pageAgent,
      args: [command],
    });
    if (!injection || injection.result === undefined || injection.result === null) {
      throw new Error('The page did not answer');
    }
    return injection.result;
  },
};
