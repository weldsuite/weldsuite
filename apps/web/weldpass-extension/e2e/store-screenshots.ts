/**
 * The store images: four 1280×800 screenshots and the 440×280 small promo
 * tile, for the Chrome Web Store and Edge Add-ons (store/README.md). They
 * show the real extension, built as for the Playwright run, against the fake
 * server, on a made-up company's sign-in page that Playwright serves at
 * https://app.northwind.example, so the extension treats it as any https
 * site. Every name in them is invented.
 *
 *   pnpm --filter weldpass-extension screenshots   # → store/screenshots/
 */

import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { LOGO_PATH, LOGO_STROKE_WIDTH, LOGO_VIEW_BOX } from '../src/lib/logo';
import { EXTENSION_ID, LOCAL_ITEM, freshState, startFakeServers, type FakeItem } from './fake-server';
import { EXTENSION_DIR } from './global-setup';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../store/screenshots');
const SITE = 'https://app.northwind.example';
const INDIGO = '#4f46e5';
const PAGE_SIZE = { width: 1040, height: 560 };

const login = (id: string, title: string, subtitle: string, url = `${SITE}/login`): FakeItem => ({
  ...LOCAL_ITEM,
  id,
  title,
  subtitle,
  url,
  host: new URL(url).hostname,
});

const ITEMS = [
  login('item-1', 'Northwind', 'ada@northwind.example'),
  login('item-2', 'Northwind (admin)', 'admin@northwind.example'),
  login('item-3', 'Contoso Mail', 'ada@northwind.example', 'https://mail.contoso.example/'),
  login('item-4', 'Fabrikam CRM', 'ada.lovelace', 'https://crm.fabrikam.example/login'),
  login('item-5', 'Tailspin Analytics', 'team@northwind.example', 'https://tailspin.example/signin'),
  login('item-6', 'Woodgrove Bank', 'finance@northwind.example', 'https://woodgrove.example/'),
];

const FONT = `font-family: Inter, "Segoe UI", system-ui, -apple-system, sans-serif;`;

const SIGN_IN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in · Northwind</title>
<style>
  body { margin: 0; min-height: 100vh; box-sizing: border-box; display: flex; justify-content: center; align-items: flex-start; padding-top: 40px; background: #f4f5f7; ${FONT} color: #111827; }
  .card { width: 380px; background: #fff; border-radius: 14px; padding: 36px 36px 32px; box-shadow: 0 1px 2px #0000000d, 0 8px 24px #0000000f; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; }
  .mark { width: 28px; height: 28px; border-radius: 8px; background: #0f766e; }
  h1 { font-size: 22px; margin: 28px 0 6px; } p { margin: 0 0 24px; color: #6b7280; font-size: 14px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 6px; }
  input { box-sizing: border-box; width: 100%; height: 40px; border: 1px solid #d1d5db; border-radius: 8px; padding: 0 12px; font-size: 14px; margin-bottom: 16px; }
  button { width: 100%; height: 42px; border: 0; border-radius: 8px; background: #0f766e; color: #fff; font-weight: 600; font-size: 14px; margin-top: 6px; }
</style></head><body>
  <form class="card" action="/welcome" method="post">
    <div class="brand"><span class="mark"></span>Northwind</div>
    <h1>Sign in</h1><p>Welcome back. Sign in to your workspace.</p>
    <label for="email">Email</label><input id="email" name="username" type="email" autocomplete="username">
    <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</body></html>`;

const WELCOME_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Northwind</title>
<style>
  body { margin: 0; ${FONT} background: #f4f5f7; color: #111827; }
  header { height: 56px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; padding: 0 28px; gap: 10px; font-weight: 700; }
  .mark { width: 24px; height: 24px; border-radius: 7px; background: #0f766e; }
  main { padding: 120px 48px 40px; } h1 { margin: 0 0 8px; font-size: 26px; } p { margin: 0; color: #6b7280; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 32px; }
  .tiles div { height: 150px; background: #fff; border-radius: 12px; box-shadow: 0 1px 2px #0000000d; }
</style></head><body>
  <header><span class="mark"></span>Northwind</header>
  <main><h1>Welcome back, Grace</h1><p>Here is what changed in your workspace.</p><div class="tiles"><div></div><div></div><div></div></div></main>
</body></html>`;

const logo = (size: number, color: string) =>
  `<svg viewBox="${LOGO_VIEW_BOX}" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${LOGO_STROKE_WIDTH}" stroke-linecap="round"><path d="${LOGO_PATH}"/></svg>`;

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

const BACKDROP = `background: radial-gradient(1200px 700px at 85% 110%, #c7d2fe 0%, transparent 60%), linear-gradient(180deg, #eef2ff 0%, #f8fafc 100%);`;

/** A 1280×800 slide: the caption above a browser window holding a page screenshot. */
function pageSlide(title: string, text: string, shot: Buffer): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; width: 1280px; height: 800px; overflow: hidden; ${BACKDROP} ${FONT} color: #111827; }
    .caption { display: flex; align-items: center; gap: 18px; padding: 40px 120px 0; }
    .tile { width: 52px; height: 52px; border-radius: 13px; background: ${INDIGO}; display: grid; place-items: center; flex: none; }
    h1 { margin: 0; font-size: 34px; letter-spacing: -0.02em; } p { margin: 6px 0 0; font-size: 18px; color: #4b5563; }
    .window { position: absolute; left: 120px; top: 158px; width: 1040px; border-radius: 12px; overflow: hidden; background: #fff; box-shadow: 0 30px 60px -20px #1e1b4b4d, 0 0 0 1px #0000000f; }
    .bar { height: 34px; background: #f3f4f6; display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid #e5e7eb; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #d1d5db; }
    .url { margin-left: 14px; flex: 1; height: 22px; border-radius: 11px; background: #fff; font-size: 12px; color: #4b5563; display: flex; align-items: center; padding: 0 12px; }
    .shot { display: block; width: 1040px; height: 560px; }
  </style></head><body>
    <div class="caption"><div class="tile">${logo(30, '#fff')}</div><div><h1>${title}</h1><p>${text}</p></div></div>
    <div class="window"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">app.northwind.example</span></div><img class="shot" src="${dataUrl(shot)}"></div>
  </body></html>`;
}

/** A 1280×800 slide: the caption on the left, the toolbar popup on the right. */
function popupSlide(title: string, text: string, shot: Buffer): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; width: 1280px; height: 800px; overflow: hidden; ${BACKDROP} ${FONT} color: #111827; display: flex; align-items: center; gap: 96px; padding: 0 140px; box-sizing: border-box; }
    .text { flex: 1; } .tile { width: 64px; height: 64px; border-radius: 16px; background: ${INDIGO}; display: grid; place-items: center; margin-bottom: 28px; }
    h1 { margin: 0; font-size: 44px; line-height: 1.12; letter-spacing: -0.02em; } p { margin: 18px 0 0; font-size: 20px; line-height: 1.5; color: #4b5563; }
    img { width: 380px; height: 540px; border-radius: 12px; box-shadow: 0 30px 60px -20px #1e1b4b59, 0 0 0 1px #0000001a; flex: none; }
  </style></head><body>
    <div class="text"><div class="tile">${logo(36, '#fff')}</div><h1>${title}</h1><p>${text}</p></div>
    <img src="${dataUrl(shot)}">
  </body></html>`;
}

const PROMO_TILE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: 440px; height: 280px; overflow: hidden; ${FONT} color: #fff;
    background: radial-gradient(420px 300px at 100% 100%, #818cf8 0%, transparent 70%), ${INDIGO};
    display: flex; flex-direction: column; justify-content: center; padding: 0 40px; box-sizing: border-box; }
  .row { display: flex; align-items: center; gap: 16px; }
  .tile { width: 64px; height: 64px; border-radius: 16px; background: #fff; display: grid; place-items: center; }
  h1 { margin: 0; font-size: 40px; letter-spacing: -0.02em; } p { margin: 20px 0 0; font-size: 19px; line-height: 1.4; color: #e0e7ff; }
</style></head><body>
  <div class="row"><div class="tile">${logo(38, INDIGO)}</div><h1>WeldPass</h1></div>
  <p>Your team's logins,<br>right where you sign in.</p>
</body></html>`;

let context: BrowserContext;
let stopServers: () => Promise<void>;
const state = freshState();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  state.items = ITEMS;
  stopServers = await startFakeServers(state);
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    locale: 'en-US',
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  await context.route(`${SITE}/**`, (route) => {
    const page = new URL(route.request().url()).pathname === '/welcome' ? WELCOME_PAGE : SIGN_IN_PAGE;
    return route.fulfill({ status: 200, contentType: 'text/html', body: page });
  });
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');

  const popup = await openPopup();
  await popup.getByRole('button', { name: 'Sign in' }).click();
  await expect(popup.getByRole('searchbox', { name: 'Search logins' })).toBeVisible();
  await popup.close();
});

test.afterAll(async () => {
  await context?.close();
  await stopServers?.();
});

/** A tab on the demo sign-in page, at the size the slide's window shows. */
async function sitePage(): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(PAGE_SIZE);
  await page.goto(`${SITE}/login`);
  return page;
}

/**
 * The toolbar popup, opened as a tab. A real popup reads the tab it was opened
 * on through the activeTab grant; here that tab is the demo sign-in page.
 */
async function openPopup(): Promise<Page> {
  const popup = await context.newPage();
  await popup.addInitScript({
    content: `chrome.tabs.query = async (info) => (info && info.active ? [{ id: 1, url: ${JSON.stringify(`${SITE}/login`)} }] : []);`,
  });
  await popup.setViewportSize({ width: 380, height: 540 });
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  return popup;
}

/** Renders slide HTML and saves it at its CSS size. */
async function save(file: string, html: string, size: { width: number; height: number }): Promise<void> {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: path.join(OUT, file), scale: 'css' });
  await page.close();
}

/** The extension's frame (`menu.html`, `prompt.html`) in `page`, once it has painted. */
async function extensionFrame(page: Page, file: string): Promise<Frame> {
  const find = () => page.frames().find((frame) => new URL(frame.url() || 'about:blank').pathname === `/${file}`);
  await expect.poll(() => Boolean(find())).toBe(true);
  // Let the frame paint and finish its entrance.
  await page.waitForTimeout(800);
  return find()!;
}

test('1: the inline menu on a sign-in page', async () => {
  const page = await sitePage();
  await page.getByLabel('Email').click();
  const menu = await extensionFrame(page, 'menu.html');
  await expect(menu.getByText('admin@northwind.example')).toBeVisible();
  const shot = await page.screenshot();
  await page.close();
  await save(
    '1-fill.png',
    pageSlide('Fill logins right where you sign in', 'Click a login field and pick a login: WeldPass fills it in.', shot),
    { width: 1280, height: 800 },
  );
});

test('2: every login from the toolbar', async () => {
  const popup = await openPopup();
  await expect(popup.getByText('Woodgrove Bank')).toBeVisible();
  const shot = await popup.screenshot();
  await popup.close();
  await save(
    '2-logins.png',
    popupSlide("All of your team's logins, one click away", 'Search them, copy a username, password or 2FA code, or open the site.', shot),
    { width: 1280, height: 800 },
  );
});

test('3: the save bar after signing in', async () => {
  const page = await sitePage();
  await page.getByLabel('Email').fill('grace@northwind.example');
  await page.getByLabel('Password').fill('a brand new secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/welcome');
  const bar = await extensionFrame(page, 'prompt.html');
  await expect(bar.getByText('Save login for app.northwind.example?')).toBeVisible();
  const shot = await page.screenshot();
  await page.close();
  await save(
    '3-save.png',
    pageSlide('Save new logins as you go', 'After you sign in, WeldPass offers to save the login, or to update a changed password.', shot),
    { width: 1280, height: 800 },
  );
});

test('4: the password generator', async () => {
  const popup = await openPopup();
  await popup.getByRole('tab', { name: 'Generator' }).or(popup.getByRole('button', { name: 'Generator' })).first().click();
  await expect(popup.getByText('Generated password')).toBeVisible();
  const shot = await popup.screenshot();
  await popup.close();
  await save(
    '4-generator.png',
    popupSlide('Strong passwords, made for you', 'Generate one in the toolbar, or right in a sign-up or change-password form.', shot),
    { width: 1280, height: 800 },
  );
});

test('the small promo tile', async () => {
  await save('promo-small.png', PROMO_TILE, { width: 440, height: 280 });
  expect(statSync(path.join(OUT, 'promo-small.png')).size).toBeGreaterThan(0);
});
