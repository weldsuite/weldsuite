/**
 * The messages between the extension's parts. The service worker is the only
 * part that holds tokens or calls the API (ADR PASS-009); everything else asks
 * it through `chrome.runtime.sendMessage`, and it answers or pushes to one
 * frame with `chrome.tabs.sendMessage`.
 *
 * Who may send what is decided by the sender, not the message (`senderKind` in
 * `background/senders.ts`):
 * - extension pages (popup, settings): everything in `PageRequest`;
 * - the inline menu and the save bar (extension pages framed into a web page):
 *   only their own `MenuRequest` / `PromptRequest`, for their own nonce;
 * - content scripts: only `ContentRequest`. Nothing a content script can ask
 *   reveals a password; a password reaches a frame only after a click inside
 *   the extension's own menu frame.
 */

import type {
  WeldPassHealthReport,
  WeldPassItem,
  WeldPassItemInput,
  WeldPassItemVersion,
  WeldPassRevealedItem,
  WeldPassTotpCode,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import type { NotificationRow } from '@weldsuite/app-api-client/domains/notifications';
import type { ServerProblem } from './server';
import type { Settings } from './settings';

// ── state ───────────────────────────────────────────────────────────────────

export interface WorkspaceSummary {
  id: string;
  name: string;
}

export interface ExtensionState {
  server: {
    origin: string;
    label: string;
    /** Why the extension can't use it, if it can't. */
    problem: ServerProblem | 'no-permission' | null;
    /** Host patterns still to be granted (`no-permission`). */
    missingPatterns: string[];
    accountUrl: string | null;
    isDefault: boolean;
  };
  /** The stored session has been read. */
  loaded: boolean;
  person: { name: string | null; email: string | null } | null;
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  loadingWorkspaces: boolean;
}

export type SignInResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'unreachable' | 'failed' | 'server'; message?: string };

// ── extension pages (popup, settings) ──────────────────────────────────────

export type PageRequest =
  | { type: 'state:get' }
  | { type: 'auth:sign-in' }
  | { type: 'auth:sign-out' }
  | { type: 'workspace:set'; workspaceId: string }
  /** Read a server's `/config.json`; the caller has asked for host access first. */
  | { type: 'server:inspect'; origin: string }
  /** Switch server (`null`: back to the build's default). Signs out of the old one. */
  | { type: 'server:set'; origin: string | null }
  | { type: 'settings:get' }
  | { type: 'settings:set'; patch: Partial<Settings> }
  | { type: 'items:match'; url: string }
  | { type: 'items:list' }
  | { type: 'vaults:list' }
  /** Weak, reused and old logins (titles and usernames only, never a password). */
  | { type: 'health:get' }
  /** The person's latest notifications and how many are unread (the popup's bell). */
  | { type: 'notifications:list' }
  | { type: 'notifications:read'; id: string }
  | { type: 'notifications:read-all' }
  | { type: 'item:reveal'; vaultId: string; itemId: string }
  | { type: 'item:totp'; vaultId: string; itemId: string }
  /** A login's versions (who changed it when; never a password), for its details page. */
  | { type: 'item:versions'; vaultId: string; itemId: string }
  | { type: 'item:create'; vaultId: string; input: WeldPassItemInput };

export interface PageResponses {
  'state:get': ExtensionState;
  'auth:sign-in': SignInResult;
  'auth:sign-out': ExtensionState;
  'workspace:set': ExtensionState;
  'server:inspect':
    | { ok: true; issuer: string; patterns: string[] }
    | { ok: false; problem: ServerProblem };
  'server:set': { ok: true; state: ExtensionState } | { ok: false; problem: ServerProblem | 'no-permission' };
  'settings:get': Settings;
  'settings:set': Settings;
  'items:match': WeldPassItem[];
  'items:list': WeldPassItem[];
  'vaults:list': WeldPassVault[];
  'health:get': WeldPassHealthReport;
  'notifications:list': { items: NotificationRow[]; unread: number };
  'notifications:read': NotificationRow;
  'notifications:read-all': { updated: number };
  'item:reveal': WeldPassRevealedItem;
  'item:totp': WeldPassTotpCode;
  'item:versions': WeldPassItemVersion[];
  'item:create': WeldPassItem;
}

// ── content scripts ─────────────────────────────────────────────────────────

/** What a focused field is for. */
export type FieldKind = 'login' | 'new-password' | 'one-time-code';

export interface FieldContext {
  kind: FieldKind;
  /** The form around the field shows a (current) password field. */
  hasPassword: boolean;
  hasUsername: boolean;
}

export type ContentRequest =
  /** On load: whether to show inline icons in this frame, and offer to save. */
  | { type: 'content:hello' }
  /** The person opened the inline menu on a field. */
  | { type: 'content:menu-open'; field: FieldContext; topOrigin: string | null }
  | { type: 'content:menu-closed'; nonce: string }
  /** A login form was submitted. Hands the login to the worker; the frame keeps nothing. */
  | { type: 'content:capture'; username: string; password: string }
  /** Top frame, on load: is there a save or update to ask about? */
  | { type: 'content:prompt-check' }
  | { type: 'content:prompt-closed'; nonce: string };

export interface ContentResponses {
  'content:hello': { inline: boolean };
  'content:menu-open': { nonce: string } | null;
  'content:menu-closed': null;
  'content:capture': null;
  'content:prompt-check': { nonce: string } | null;
  'content:prompt-closed': null;
}

// ── the inline menu (menu.html, framed into the page) ───────────────────────

export interface MenuItem {
  id: string;
  vaultId: string;
  title: string;
  username: string | null;
  host: string | null;
  hasTotp: boolean;
}

export interface MenuContext {
  kind: FieldKind;
  /** The frame the field is in: the only place a pick is filled. */
  frameOrigin: string;
  /** Named in the menu when the field sits in a frame of another origin than the tab. */
  crossOrigin: boolean;
  items: MenuItem[];
  /** The fill policy refuses this frame altogether (plain http, an unsupported page). */
  blocked: boolean;
}

export type MenuRequest =
  | { type: 'menu:init'; nonce: string }
  | { type: 'menu:fill'; nonce: string; itemId: string; vaultId: string }
  | { type: 'menu:totp'; nonce: string; itemId: string; vaultId: string }
  | { type: 'menu:generated'; nonce: string; password: string }
  | { type: 'menu:close'; nonce: string };

export type MenuOutcome =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'refused' | 'no-fields' | 'page-changed' | 'error'; message?: string };

export interface MenuResponses {
  'menu:init': MenuContext | null;
  'menu:fill': MenuOutcome;
  'menu:totp': MenuOutcome;
  'menu:generated': MenuOutcome;
  'menu:close': null;
}

// ── the save bar (prompt.html, framed into the page) ────────────────────────

export interface PromptContext {
  kind: 'save' | 'update';
  host: string;
  username: string;
  /** The login an update replaces. */
  itemTitle: string | null;
  /** Vaults a new login can go into (editor or manager). Empty for an update. */
  vaults: Array<{ id: string; name: string; personal: boolean }>;
}

export type PromptRequest =
  | { type: 'prompt:init'; nonce: string }
  | { type: 'prompt:save'; nonce: string; vaultId: string }
  | { type: 'prompt:update'; nonce: string }
  | { type: 'prompt:never'; nonce: string }
  | { type: 'prompt:dismiss'; nonce: string };

export type PromptOutcome = { ok: true } | { ok: false; reason: 'expired' | 'error'; message?: string };

export interface PromptResponses {
  'prompt:init': PromptContext | null;
  'prompt:save': PromptOutcome;
  'prompt:update': PromptOutcome;
  'prompt:never': PromptOutcome;
  'prompt:dismiss': PromptOutcome;
}

// ── worker → one frame ──────────────────────────────────────────────────────

export type FrameCommand =
  | {
      type: 'fill:login';
      /** The menu the person picked in; the frame fills only for its own open menu. */
      nonce: string;
      /** The origin the worker validated; the frame refuses any other. */
      expectedOrigin: string;
      itemHost: string;
      username: string;
      /** Null on the first step of a two-step login: no reveal was made. */
      password: string | null;
    }
  | { type: 'fill:otp'; nonce: string; expectedOrigin: string; itemHost: string; code: string }
  | { type: 'fill:new-password'; nonce: string; expectedOrigin: string; password: string }
  | { type: 'menu:remove'; nonce: string }
  | { type: 'prompt:remove'; nonce: string }
  /** Top frame: a save is pending, look for it (a login that didn't navigate). */
  | { type: 'prompt:poke' };

export type FrameResult =
  | { status: 'filled'; fields: number }
  | { status: 'origin-mismatch' }
  | { status: 'refused' }
  | { status: 'no-fields' }
  | { status: 'ok' };

/** Broadcast to open extension pages when the session or server changes. */
export interface StateChanged {
  type: 'state:changed';
}

export type AnyRequest = PageRequest | ContentRequest | MenuRequest | PromptRequest;

/** Responses are wrapped so an error crosses the message channel as data. */
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; status?: number } };
