import { Hono } from 'hono';
import { z } from 'zod';
import puppeteer from '@cloudflare/puppeteer';
import type { Env } from '../env';
import { computerEnabled } from '../lib/auth';

type AppEnv = { Bindings: Env };

const openSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(64),
  url: z.string().url().max(2000),
  keepAliveMs: z.number().int().min(0).max(600_000).optional(),
});

const sessionSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(64),
});

const actSchema = sessionSchema.extend({
  action: z.enum(['goto', 'click', 'type', 'press', 'wait', 'screenshot', 'extract', 'live_view']),
  url: z.string().url().max(2000).optional(),
  selector: z.string().max(500).optional(),
  text: z.string().max(5000).optional(),
  key: z.string().max(50).optional(),
  waitMs: z.number().int().min(0).max(30_000).optional(),
});

interface StoredSession {
  sessionId: string;
  createdAt: string;
  lastUrl?: string;
}

function sessionKey(workspaceId: string, agentId: string): string {
  return `browser:${workspaceId}:${agentId}`;
}

async function loadSession(env: Env, workspaceId: string, agentId: string): Promise<StoredSession | null> {
  if (!env.BROWSER_SESSIONS) return null;
  const raw = await env.BROWSER_SESSIONS.get(sessionKey(workspaceId, agentId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

async function saveSession(env: Env, workspaceId: string, agentId: string, session: StoredSession) {
  if (!env.BROWSER_SESSIONS) return;
  await env.BROWSER_SESSIONS.put(sessionKey(workspaceId, agentId), JSON.stringify(session), {
    expirationTtl: 60 * 60,
  });
}

async function clearSession(env: Env, workspaceId: string, agentId: string) {
  if (!env.BROWSER_SESSIONS) return;
  await env.BROWSER_SESSIONS.delete(sessionKey(workspaceId, agentId));
}

function pageTextFn(): string {
  // Runs in the browser; keep body as string to avoid DOM types in the Worker.
  return (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document?.body
    ?.innerText?.slice(0, 8000) ?? '';
}

async function resolveSessionId(browser: {
  sessionId?: (() => string) | string;
}): Promise<string | undefined> {
  if (typeof browser.sessionId === 'function') return browser.sessionId();
  if (typeof browser.sessionId === 'string') return browser.sessionId;
  return undefined;
}

export const browserRoutes = new Hono<AppEnv>();

browserRoutes.post('/open', async (c) => {
  if (!computerEnabled(c.env)) return c.json({ error: 'Computer disabled' }, 503);
  if (!c.env.BROWSER) return c.json({ error: 'BROWSER binding not configured' }, 503);

  const body = openSchema.parse(await c.req.json());
  const browser = await puppeteer.launch(c.env.BROWSER, {
    keep_alive: body.keepAliveMs ?? 60_000,
  });
  const page = await browser.newPage();
  await page.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const title = await page.title();
  const text = await page.evaluate(pageTextFn);
  const screenshot = (await page.screenshot({ type: 'jpeg', quality: 60 })) as Buffer;
  let liveViewUrl: string | undefined;
  try {
    const cdp = await page.createCDPSession();
    const live = (await cdp.send('Cloudflare.getLiveView' as never, {
      mode: 'tab',
      expiresInMs: 300_000,
    } as never)) as { devtoolsFrontendUrl?: string };
    liveViewUrl = live.devtoolsFrontendUrl;
  } catch {
    // Live View not available in all environments.
  }

  const resolvedId = await resolveSessionId(browser as { sessionId?: (() => string) | string });
  if (resolvedId) {
    await saveSession(c.env, body.workspaceId, body.agentId, {
      sessionId: resolvedId,
      createdAt: new Date().toISOString(),
      lastUrl: body.url,
    });
  }

  try {
    await browser.disconnect();
  } catch {
    await browser.close().catch(() => undefined);
  }

  return c.json({
    ok: true,
    title,
    url: body.url,
    text: truncate(String(text), 8000),
    screenshotBase64: bufferToBase64(screenshot).slice(0, 200_000),
    liveViewUrl,
    sessionId: resolvedId ?? null,
  });
});

browserRoutes.post('/act', async (c) => {
  if (!computerEnabled(c.env)) return c.json({ error: 'Computer disabled' }, 503);
  if (!c.env.BROWSER) return c.json({ error: 'BROWSER binding not configured' }, 503);

  const body = actSchema.parse(await c.req.json());
  const stored = await loadSession(c.env, body.workspaceId, body.agentId);

  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  if (stored?.sessionId) {
    try {
      browser = await puppeteer.connect(c.env.BROWSER, stored.sessionId);
    } catch {
      browser = await puppeteer.launch(c.env.BROWSER, { keep_alive: 60_000 });
    }
  } else {
    browser = await puppeteer.launch(c.env.BROWSER, { keep_alive: 60_000 });
  }

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());

  try {
    switch (body.action) {
      case 'goto': {
        if (!body.url) return c.json({ error: 'url required for goto' }, 400);
        await page.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        break;
      }
      case 'click': {
        if (!body.selector) return c.json({ error: 'selector required for click' }, 400);
        await page.click(body.selector);
        break;
      }
      case 'type': {
        if (!body.selector || body.text == null) {
          return c.json({ error: 'selector and text required for type' }, 400);
        }
        await page.type(body.selector, body.text);
        break;
      }
      case 'press': {
        if (!body.key) return c.json({ error: 'key required for press' }, 400);
        await page.keyboard.press(body.key as never);
        break;
      }
      case 'wait': {
        await new Promise((r) => setTimeout(r, body.waitMs ?? 1000));
        break;
      }
      case 'screenshot':
      case 'extract':
      case 'live_view':
        break;
      default:
        return c.json({ error: 'Unknown action' }, 400);
    }

    const title = await page.title();
    const url = page.url();
    const text =
      body.action === 'extract' || body.action === 'goto'
        ? await page.evaluate(pageTextFn)
        : undefined;
    const screenshot =
      body.action === 'screenshot' || body.action === 'goto' || body.action === 'extract'
        ? bufferToBase64((await page.screenshot({ type: 'jpeg', quality: 60 })) as Buffer)
        : undefined;

    let liveViewUrl: string | undefined;
    if (body.action === 'live_view' || body.action === 'goto') {
      try {
        const cdp = await page.createCDPSession();
        const live = (await cdp.send('Cloudflare.getLiveView' as never, {
          mode: 'tab',
          expiresInMs: 300_000,
        } as never)) as { devtoolsFrontendUrl?: string };
        liveViewUrl = live.devtoolsFrontendUrl;
      } catch {
        // optional
      }
    }

    const sid =
      stored?.sessionId ??
      (await resolveSessionId(browser as { sessionId?: (() => string) | string }));
    if (sid) {
      await saveSession(c.env, body.workspaceId, body.agentId, {
        sessionId: sid,
        createdAt: stored?.createdAt ?? new Date().toISOString(),
        lastUrl: url,
      });
    }

    await browser.disconnect().catch(() => browser.close().catch(() => undefined));

    return c.json({
      ok: true,
      action: body.action,
      title,
      url,
      text: text ? truncate(String(text), 8000) : undefined,
      screenshotBase64: screenshot?.slice(0, 200_000),
      liveViewUrl,
      sessionId: sid ?? null,
    });
  } catch (err) {
    await browser.close().catch(() => undefined);
    return c.json(
      { error: err instanceof Error ? err.message : 'Browser action failed' },
      500,
    );
  }
});

browserRoutes.post('/close', async (c) => {
  if (!c.env.BROWSER) return c.json({ error: 'BROWSER binding not configured' }, 503);
  const body = sessionSchema.parse(await c.req.json());
  const stored = await loadSession(c.env, body.workspaceId, body.agentId);
  if (stored?.sessionId) {
    try {
      const browser = await puppeteer.connect(c.env.BROWSER, stored.sessionId);
      await browser.close();
    } catch {
      // already gone
    }
  }
  await clearSession(c.env, body.workspaceId, body.agentId);
  return c.json({ ok: true });
});

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated]`;
}

function bufferToBase64(buf: Buffer | ArrayBuffer | Uint8Array): string {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buf)) {
    return buf.toString('base64');
  }
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
