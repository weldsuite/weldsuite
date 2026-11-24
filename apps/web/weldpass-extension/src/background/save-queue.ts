/**
 * Logins waiting for the "save this login?" bar (ADR PASS-009, plan 2C).
 *
 * A submit in a page hands origin, username and password to the worker,
 * which keeps them here, keyed by tab, for at most five minutes. The store is
 * `chrome.storage.session`: memory only, never written to disk, gone when the
 * browser quits. Nothing here is logged.
 *
 * Also kept per tab, for the same five minutes:
 * - what the extension filled (item, username and a salted hash of the
 *   password, never the password), so a submit of exactly that login asks
 *   nothing;
 * - the username of a two-step login's first step, for its second.
 */

import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';

/** A key-value store that never touches disk (`chrome.storage.session`). */
export interface MemoryStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export const PENDING_TTL_MS = 5 * 60_000;

export interface ItemRef {
  id: string;
  vaultId: string;
  title: string;
}

export interface PendingLogin {
  origin: string;
  host: string;
  /** Origin and path of the page, stored with a new login (never the query or fragment). */
  url: string;
  username: string;
  password: string;
  kind: 'save' | 'update';
  /** The login an update replaces. */
  item: ItemRef | null;
  at: number;
}

export interface FillRecord {
  host: string;
  item: ItemRef;
  username: string;
  /** SHA-256 of salt and password, so a submit of the filled login is recognised. */
  passwordHash: string;
  at: number;
}

interface UsernameHint {
  host: string;
  username: string;
  at: number;
}

const pendingKey = (tabId: number) => `weldpass:pending:${tabId}`;
const fillKey = (tabId: number) => `weldpass:filled:${tabId}`;
const hintKey = (tabId: number) => `weldpass:username:${tabId}`;
const SALT_KEY = 'weldpass:salt';

function fresh<T extends { at: number }>(entry: T | undefined, now: number): T | null {
  return entry && now - entry.at <= PENDING_TTL_MS && entry.at <= now ? entry : null;
}

export class SaveQueue {
  constructor(
    private readonly store: MemoryStore,
    private readonly now: () => number = Date.now,
  ) {}

  async put(tabId: number, login: Omit<PendingLogin, 'at'>): Promise<void> {
    await this.store.set(pendingKey(tabId), { ...login, at: this.now() });
  }

  /** The pending login of a tab; an expired one is dropped. */
  async get(tabId: number): Promise<PendingLogin | null> {
    const entry = fresh(await this.store.get<PendingLogin>(pendingKey(tabId)), this.now());
    if (!entry) await this.store.remove(pendingKey(tabId));
    return entry;
  }

  /** Take it out: saved, updated, dismissed or refused. */
  async take(tabId: number): Promise<PendingLogin | null> {
    const entry = await this.get(tabId);
    await this.store.remove(pendingKey(tabId));
    return entry;
  }

  async recordFill(tabId: number, record: Omit<FillRecord, 'at' | 'passwordHash'>, password: string): Promise<void> {
    await this.store.set(fillKey(tabId), {
      ...record,
      passwordHash: await this.hash(password),
      at: this.now(),
    } satisfies FillRecord);
  }

  async fillRecord(tabId: number): Promise<FillRecord | null> {
    return fresh(await this.store.get<FillRecord>(fillKey(tabId)), this.now());
  }

  async rememberUsername(tabId: number, host: string, username: string): Promise<void> {
    await this.store.set(hintKey(tabId), { host, username, at: this.now() } satisfies UsernameHint);
  }

  async username(tabId: number, host: string): Promise<string | null> {
    const hint = fresh(await this.store.get<UsernameHint>(hintKey(tabId)), this.now());
    return hint?.host === host ? hint.username : null;
  }

  /** The tab closed: forget everything about it. */
  async clearTab(tabId: number): Promise<void> {
    await Promise.all([pendingKey, fillKey, hintKey].map((key) => this.store.remove(key(tabId))));
  }

  async hash(password: string): Promise<string> {
    let salt = await this.store.get<string>(SALT_KEY);
    if (!salt) {
      salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      await this.store.set(SALT_KEY, salt);
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${password}`));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

export type CaptureDecision =
  | { action: 'ignore' }
  | { action: 'save' }
  | { action: 'update'; item: ItemRef }
  /** A saved login with this username exists: reveal it, and ask only if the password differs. */
  | { action: 'compare'; item: ItemRef };

const sameUser = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const ref = (item: WeldPassItem): ItemRef => ({ id: item.id, vaultId: item.vaultId, title: item.title });

/**
 * What a submitted login means. `matches` are the saved logins for its host
 * (from `/items/match`, metadata only).
 */
export function decideCapture(input: {
  username: string;
  passwordHash: string;
  fill: FillRecord | null;
  host: string;
  matches: WeldPassItem[];
}): CaptureDecision {
  const { username, passwordHash, fill, host, matches } = input;

  // The extension filled this host: unchanged means nothing to ask.
  if (fill?.host === host && (!username || sameUser(username, fill.username))) {
    return fill.passwordHash === passwordHash ? { action: 'ignore' } : { action: 'update', item: fill.item };
  }

  const logins = matches.filter((item) => item.type === 'login');
  if (!username) {
    // A password without a username: compare with the site's only login;
    // with several, don't guess which.
    if (logins.length === 1) return { action: 'compare', item: ref(logins[0]!) };
    return logins.length > 1 ? { action: 'ignore' } : { action: 'save' };
  }
  const sameName = logins.find((item) => sameUser(item.subtitle ?? '', username));
  return sameName ? { action: 'compare', item: ref(sameName) } : { action: 'save' };
}
