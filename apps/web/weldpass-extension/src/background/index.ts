/**
 * The service worker entry: `chrome.*` wired to `WeldPassWorker`.
 *
 * Every listener is registered synchronously at the top level, as MV3
 * requires for a worker that is woken by events. Messages are answered by
 * sender kind (`senders.ts`); nothing a message says about itself is trusted.
 * Errors cross the channel as codes, never with their text, and nothing here
 * logs a message's contents.
 */

import { isApiError, isNetworkError } from '@weldsuite/api-client';
import { defaultServerFrom } from '../lib/build-config';
import type {
  AnyRequest,
  ContentRequest,
  Envelope,
  MenuRequest,
  PageRequest,
  PromptRequest,
  StateChanged,
} from '../lib/protocol';
import { allowed, senderKind, type SenderKind } from './senders';
import { keyValueStore, memoryStore, secureStore } from './stores';
import { WeldPassWorker, WorkerError } from './worker';

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

const worker = new WeldPassWorker({
  defaultServer: defaultServerFrom(import.meta.env),
  fetchImpl: (input, init) => fetch(input, init),
  local: keyValueStore(chrome.storage.local),
  secure: secureStore(chrome.storage.local),
  session: keyValueStore(chrome.storage.session),
  memory: memoryStore(chrome.storage.session),
  memoryKeys: async () => Object.keys(await chrome.storage.session.get(null)),
  launchWebAuthFlow: (details) => chrome.identity.launchWebAuthFlow(details),
  redirectUri: chrome.identity.getRedirectURL(),
  hasPermission: (origins) => chrome.permissions.contains({ origins }),
  removePermission: async (origins) => {
    await chrome.permissions.remove({ origins });
  },
  sendToFrame: (tabId, command, target) => chrome.tabs.sendMessage(tabId, command, target),
  broadcast: () => {
    const message: StateChanged = { type: 'state:changed' };
    // No open extension page is not an error.
    chrome.runtime.sendMessage(message).catch(() => undefined);
  },
  randomId,
});

function errorCode(error: unknown): { code: string; status?: number } {
  if (error instanceof WorkerError) return { code: error.code };
  if (isNetworkError(error)) return { code: 'network' };
  if (isApiError(error)) return { code: 'api', status: error.status };
  if (error instanceof Error && error.message === 'Authentication required') return { code: 'signed-out' };
  return { code: 'error' };
}

function handlePage(message: PageRequest): Promise<unknown> {
  switch (message.type) {
    case 'state:get':
      return worker.state();
    case 'auth:sign-in':
      return worker.signIn();
    case 'auth:sign-out':
      return worker.signOut();
    case 'workspace:set':
      return worker.setWorkspace(String(message.workspaceId));
    case 'server:inspect':
      return worker.inspect(String(message.origin));
    case 'server:set':
      return worker.setServer(typeof message.origin === 'string' ? message.origin : null);
    case 'settings:get':
      return worker.settings();
    case 'settings:set':
      return worker.setSettings(message.patch ?? {});
    case 'items:match':
      return worker.passwords().then(async (api) => (await api.matchItems(String(message.url))).data);
    case 'items:list':
      return worker.passwords().then(async (api) => (await api.listItems({ type: 'login' })).data);
    case 'vaults:list':
      return worker.passwords().then(async (api) => (await api.listVaults()).data);
    case 'item:reveal':
      return worker
        .passwords()
        .then(async (api) => (await api.revealItem(String(message.vaultId), String(message.itemId))).data);
    case 'item:totp':
      return worker
        .passwords()
        .then(async (api) => (await api.generateTotp(String(message.vaultId), String(message.itemId))).data);
    case 'item:create':
      return worker
        .passwords()
        .then(async (api) => (await api.createItem(String(message.vaultId), message.input)).data);
    default:
      return Promise.reject(new WorkerError('invalid'));
  }
}

function handleContent(sender: Extract<SenderKind, { kind: 'content' }>, message: ContentRequest): Promise<unknown> {
  switch (message.type) {
    case 'content:hello':
      return worker.hello(sender);
    case 'content:menu-open':
      return worker.menuOpen(sender, message.field, message.topOrigin);
    case 'content:menu-closed':
      return worker.menuClosed(sender, String(message.nonce));
    case 'content:capture':
      return worker.capture(sender, message.username, message.password);
    case 'content:prompt-check':
      return worker.promptCheck(sender);
    case 'content:prompt-closed':
      return worker.promptClosed(sender, String(message.nonce));
    default:
      return Promise.reject(new WorkerError('invalid'));
  }
}

function handleMenu(tabId: number, message: MenuRequest): Promise<unknown> {
  const nonce = String(message.nonce);
  switch (message.type) {
    case 'menu:init':
      return worker.menuInit(tabId, nonce);
    case 'menu:fill':
      return worker.menuFill(tabId, nonce, String(message.itemId), String(message.vaultId));
    case 'menu:totp':
      return worker.menuTotp(tabId, nonce, String(message.itemId), String(message.vaultId));
    case 'menu:generated':
      return worker.menuGenerated(tabId, nonce, message.password);
    case 'menu:close':
      return worker.menuClose(tabId, nonce);
    default:
      return Promise.reject(new WorkerError('invalid'));
  }
}

function handlePrompt(tabId: number, message: PromptRequest): Promise<unknown> {
  const nonce = String(message.nonce);
  switch (message.type) {
    case 'prompt:init':
      return worker.promptInit(tabId, nonce);
    case 'prompt:save':
      return worker.promptSave(tabId, nonce, String(message.vaultId));
    case 'prompt:update':
      return worker.promptUpdate(tabId, nonce);
    case 'prompt:never':
      return worker.promptNever(tabId, nonce);
    case 'prompt:dismiss':
      return worker.promptDismiss(tabId, nonce);
    default:
      return Promise.reject(new WorkerError('invalid'));
  }
}

function route(sender: SenderKind, message: AnyRequest): Promise<unknown> {
  switch (sender.kind) {
    case 'page':
      return handlePage(message as PageRequest);
    case 'content':
      return handleContent(sender, message as ContentRequest);
    case 'menu':
      return handleMenu(sender.tabId, message as MenuRequest);
    case 'prompt':
      return handlePrompt(sender.tabId, message as PromptRequest);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, rawSender, sendResponse) => {
  const sender = senderKind(rawSender, chrome.runtime.id);
  const type = typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined;
  if (!sender || typeof type !== 'string' || !allowed(sender, type)) return false;

  route(sender, message as AnyRequest).then(
    // A handler with nothing to say answers null, so every reply carries a value.
    (value) => sendResponse({ ok: true, value: value ?? null } satisfies Envelope<unknown>),
    (error: unknown) => sendResponse({ ok: false, error: errorCode(error) } satisfies Envelope<unknown>),
  );
  return true;
});

chrome.permissions.onAdded.addListener(() => void worker.permissionsChanged());
chrome.permissions.onRemoved.addListener(() => void worker.permissionsChanged());

chrome.tabs.onRemoved.addListener((tabId) => {
  void worker.tabClosed(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  // Content scripts reach tabs opened after install; the open ones get it now.
  void (async () => {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (tab.id === undefined || tab.discarded) continue;
      chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
        .catch(() => undefined);
    }
  })();
});

// Read the stored session as soon as the worker wakes.
void worker.init();
