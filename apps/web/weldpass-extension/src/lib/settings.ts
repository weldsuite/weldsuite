/**
 * The person's extension settings, in `chrome.storage.local` (nothing secret):
 * whether inline menus and save prompts show, and the sites where each never
 * does. Sites are hosts only, never paths (ADR PASS-009); a listed host also
 * covers its subdomains.
 */

import { hostOf } from '@weldsuite/app-api-client/schemas/weldpass-passwords';

export interface Settings {
  inlineMenus: boolean;
  savePrompts: boolean;
  /** Hosts where no inline icon or menu shows. */
  neverMenuHosts: string[];
  /** Hosts where the extension never offers to save or update a login. */
  neverSaveHosts: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  inlineMenus: true,
  savePrompts: true,
  neverMenuHosts: [],
  neverSaveHosts: [],
};

export const SETTINGS_KEY = 'weldpass:settings';
const MAX_HOSTS = 500;

function hostList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hosts = value
    .map((entry) => (typeof entry === 'string' ? hostOf(entry) : null))
    .filter((host): host is string => host !== null);
  return [...new Set(hosts)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_HOSTS);
}

/** Whatever is stored, as valid settings. Unknown or broken values fall back to the defaults. */
export function readSettings(value: unknown): Settings {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    inlineMenus: typeof record.inlineMenus === 'boolean' ? record.inlineMenus : DEFAULT_SETTINGS.inlineMenus,
    savePrompts: typeof record.savePrompts === 'boolean' ? record.savePrompts : DEFAULT_SETTINGS.savePrompts,
    neverMenuHosts: hostList(record.neverMenuHosts),
    neverSaveHosts: hostList(record.neverSaveHosts),
  };
}

export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  return readSettings({ ...current, ...patch });
}

/** Whether `host` is on `list`, or a subdomain of a host on it. */
export function isListed(host: string | null, list: readonly string[]): boolean {
  if (!host) return false;
  // A dot-prefixed suffix: `example.com` covers `login.example.com`, never `badexample.com`.
  return list.some((listed) => host === listed || host.endsWith(`.${listed}`));
}

export function withHost(list: readonly string[], host: string): string[] {
  return hostList([...list, host]);
}

export function withoutHost(list: readonly string[], host: string): string[] {
  return list.filter((entry) => entry !== host);
}
