/**
 * The unpacked extension in Chromium against local login pages (plan
 * weldpass-eu.md, phase 2 tests): sign-in through the service worker, an
 * inline fill, a fill into a cross-origin frame, a refused fill for another
 * host, and the save and update bars.
 *
 * The inline menu and the save bar sit in closed shadow roots, so they are
 * reached as frames (`page.frames()`), never through the page's DOM. Clicks
 * in them are real input events: the menu's click guard (visible for 500 ms,
 * IntersectionObserver v2) applies to them as to a person's.
 */

import { chromium, expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { APP, EXTENSION_ID, FRAME, freshState, startFakeServers } from './fake-server';
import { EXTENSION_DIR } from './global-setup';

const state = freshState();
let context: BrowserContext;
let stopServers: () => Promise<void>;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  stopServers = await startFakeServers(state);
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  expect(worker.url()).toBe(`chrome-extension://${EXTENSION_ID}/background.js`);
});

test.afterAll(async () => {
  await context?.close();
  await stopServers?.();
});

test.beforeEach(() => {
  Object.assign(state, freshState());
});

/** A frame of the extension's (`menu.html`, `prompt.html`) inside `page`, once it has loaded. */
/** Whether a frame shows this extension page (by path: framed pages use a dynamic host). */
const isPage = (frame: Frame, file: string) => new URL(frame.url() || 'about:blank').pathname === `/${file}`;

async function extensionFrame(page: Page, file: string): Promise<Frame> {
  const find = () => page.frames().find((frame) => isPage(frame, file));
  await expect.poll(() => Boolean(find()), { message: `${file} frame` }).toBe(true);
  const frame = find()!;
  await frame.waitForLoadState('domcontentloaded');
  return frame;
}

test('signs in through WeldID from the service worker and picks the only workspace', async () => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await popup.getByRole('button', { name: 'Sign in' }).click();
  await expect(popup.getByRole('button', { name: 'Search logins' })).toBeVisible();
  await expect(popup.getByText('Local app')).toBeVisible();
  // Every API call named the workspace (header mode).
  expect(new Set(state.recorded.workspaceHeaders)).toEqual(new Set(['ws_1']));
  await popup.close();
});

test('fills a login from the inline menu', async () => {
  const page = await context.newPage();
  await page.goto(`${APP}/login`);
  await page.getByLabel('Email').click();

  const menu = await extensionFrame(page, 'menu.html');
  await menu.getByRole('button', { name: /Local app/ }).click();

  await expect(page.getByLabel('Email')).toHaveValue('ada@example.com');
  await expect(page.getByLabel('Password')).toHaveValue('correct horse battery');
  expect(state.recorded.reveals).toEqual(['item-local']);
  // Only the origin went to the server for matching.
  expect(state.recorded.matchUrls.every((url) => url === APP)).toBe(true);
  await expect.poll(() => page.frames().some((frame) => isPage(frame, 'menu.html'))).toBe(false);
  await page.close();
});

test('fills a login frame of another origin, and says so', async () => {
  const page = await context.newPage();
  await page.goto(`${APP}/frame-host`);
  const login = page.frameLocator('iframe[title="Sign in"]');
  await login.getByLabel('Email').click();

  const menu = await extensionFrame(page, 'menu.html');
  await expect(menu.getByText('Fills into localhost:4511, a frame inside this page.')).toBeVisible();
  await menu.getByRole('button', { name: /Local app/ }).click();

  await expect(login.getByLabel('Password')).toHaveValue('correct horse battery');
  // The frame's own origin was matched, not the page around it.
  expect(state.recorded.matchUrls).toContain(FRAME);
  await expect(page.locator('body')).not.toContainText('correct horse');
  await page.close();
});

test('refuses a login for another host, without revealing it', async () => {
  state.matches = 'evil';
  const page = await context.newPage();
  await page.goto(`${APP}/login`);
  await page.getByLabel('Email').click();

  const menu = await extensionFrame(page, 'menu.html');
  await expect(menu.getByText('No saved logins for this site.')).toBeVisible();
  await expect(menu.getByRole('button', { name: /Evil/ })).toHaveCount(0);
  expect(state.recorded.reveals).toEqual([]);
  await expect(page.getByLabel('Password')).toHaveValue('');
  await page.close();
});

test('offers to save a new login on the next page, and saves it', async () => {
  const page = await context.newPage();
  await page.goto(`${APP}/login`);
  await page.getByLabel('Email').fill('grace@example.com');
  await page.getByLabel('Password').fill('a brand new secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/welcome');

  const bar = await extensionFrame(page, 'prompt.html');
  await expect(bar.getByText('Save login for localhost?')).toBeVisible();
  await expect(bar.getByText('grace@example.com')).toBeVisible();
  // The bar shows who, never the password.
  await expect(bar.locator('body')).not.toContainText('a brand new secret');
  await bar.getByRole('button', { name: 'Save login' }).click();

  await expect.poll(() => state.recorded.created.length).toBe(1);
  expect(state.recorded.created[0]).toEqual({
    type: 'login',
    title: 'localhost',
    url: `${APP}/login`,
    fields: { username: 'grace@example.com', password: 'a brand new secret', totp: '', notes: '' },
  });
  await expect.poll(() => page.frames().some((frame) => isPage(frame, 'prompt.html'))).toBe(false);
  await page.close();
});

test('offers to update a saved login whose password changed', async () => {
  const page = await context.newPage();
  await page.goto(`${APP}/login`);
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Password').fill('a changed password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/welcome');

  const bar = await extensionFrame(page, 'prompt.html');
  await expect(bar.getByText('Update the password of Local app?')).toBeVisible();
  await bar.getByRole('button', { name: 'Update' }).click();

  await expect.poll(() => state.recorded.updated.length).toBe(1);
  expect(state.recorded.updated[0]).toMatchObject({
    path: '/api/weldpass/vaults/vault-1/items/item-local',
    body: { type: 'login', fields: { username: 'ada@example.com', password: 'a changed password' } },
  });
  expect(state.recorded.created).toEqual([]);
  await page.close();
});

test('asks nothing after signing in with exactly the login it filled', async () => {
  const page = await context.newPage();
  await page.goto(`${APP}/login`);
  await page.getByLabel('Email').click();
  const menu = await extensionFrame(page, 'menu.html');
  await menu.getByRole('button', { name: /Local app/ }).click();
  await expect(page.getByLabel('Password')).toHaveValue('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/welcome');
  // No bar may load, for longer than the worker's poke after a submit.
  const bar = await page
    .waitForEvent('framenavigated', { predicate: (frame) => isPage(frame, 'prompt.html'), timeout: 2000 })
    .catch(() => null);
  expect(bar).toBeNull();
  expect(page.frames().some((frame) => isPage(frame, 'prompt.html'))).toBe(false);
  await page.close();
});
