/**
 * Lightweight WeldSuite-like host page for `weld app dev`.
 *
 * Realism over pixel-perfect parity: far-left app rail + content card +
 * postMessage bridge so the app-sdk uses the real iframe handshake (with
 * `localPreview: true` for in-memory storage).
 */

export interface LocalShellPageOptions {
  appUrl: string;
  appCode: string;
  appName: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJs(value: string): string {
  return JSON.stringify(value);
}

export function renderLocalShellHtml(options: LocalShellPageOptions): string {
  const appUrl = options.appUrl;
  const appCode = options.appCode;
  const appName = options.appName;
  const title = `${appName} · WeldSuite local shell`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --chrome: #e8eaed;
      --panel: #f4f5f7;
      --card: #ffffff;
      --fg: #1a1d23;
      --muted: #6b7280;
      --border: #d1d5db;
      --accent: #2563eb;
      --rail: #111827;
      --rail-fg: #e5e7eb;
      --rail-active: #374151;
      --amber-bg: #fef3c7;
      --amber-fg: #78350f;
      --amber-border: #fcd34d;
      --toast-bg: #111827;
      --toast-fg: #f9fafb;
      --danger: #dc2626;
      --ok: #16a34a;
      font-family: "Segoe UI", "Helvetica Neue", ui-sans-serif, system-ui, sans-serif;
    }
    html[data-theme="dark"] {
      --chrome: #0f1218;
      --panel: #161b22;
      --card: #1c2330;
      --fg: #f3f4f6;
      --muted: #9ca3af;
      --border: #2d3648;
      --rail: #06080c;
      --rail-fg: #d1d5db;
      --rail-active: #1f2937;
      --amber-bg: #422006;
      --amber-fg: #fde68a;
      --amber-border: #92400e;
      --toast-bg: #f9fafb;
      --toast-fg: #111827;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; background: var(--chrome); color: var(--fg); }
    body { display: flex; min-height: 100%; }
    .rail {
      width: 56px;
      flex-shrink: 0;
      background: var(--rail);
      color: var(--rail-fg);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 12px 0;
      gap: 8px;
    }
    .rail-logo {
      width: 32px; height: 32px; border-radius: 8px;
      background: linear-gradient(135deg, #3b82f6, #0ea5e9);
      display: grid; place-items: center;
      font-weight: 700; font-size: 14px; color: white;
      margin-bottom: 8px;
    }
    .rail-btn {
      width: 40px; height: 40px; border-radius: 10px;
      border: 0; background: transparent; color: inherit;
      cursor: pointer; display: grid; place-items: center;
      font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
    }
    .rail-btn:hover, .rail-btn.active { background: var(--rail-active); }
    .rail-spacer { flex: 1; }
    .main {
      flex: 1; min-width: 0; min-height: 0;
      display: flex; flex-direction: column;
      padding: 10px 12px 12px 8px;
      gap: 8px;
    }
    .banner {
      flex-shrink: 0;
      display: flex; align-items: center; gap: 10px;
      padding: 8px 12px;
      border-radius: 10px;
      background: var(--amber-bg);
      color: var(--amber-fg);
      border: 1px solid var(--amber-border);
      font-size: 12px;
    }
    .banner strong { text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px; }
    .banner code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; opacity: 0.85; }
    .banner .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card {
      flex: 1; min-height: 0;
      display: flex; flex-direction: column;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgb(0 0 0 / 4%);
    }
    .topbar {
      flex-shrink: 0;
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
    }
    .crumbs { font-size: 13px; color: var(--muted); }
    .crumbs strong { color: var(--fg); font-weight: 600; }
    .topbar .grow { flex: 1; }
    .chip {
      font-size: 11px; padding: 3px 8px; border-radius: 999px;
      border: 1px solid var(--border); color: var(--muted);
    }
    .iframe-wrap { flex: 1; min-height: 0; position: relative; background: var(--card); }
    iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: var(--card); }
    #toasts {
      position: fixed; right: 16px; bottom: 16px; z-index: 50;
      display: flex; flex-direction: column; gap: 8px; max-width: min(360px, calc(100vw - 32px));
    }
    .toast {
      padding: 10px 14px; border-radius: 10px;
      background: var(--toast-bg); color: var(--toast-fg);
      font-size: 13px; box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
      animation: in 160ms ease-out;
    }
    .toast.success { box-shadow: inset 3px 0 0 var(--ok); }
    .toast.error { box-shadow: inset 3px 0 0 var(--danger); }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .nav-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted); }
  </style>
</head>
<body>
  <aside class="rail" aria-label="App rail">
    <div class="rail-logo" title="WeldSuite">W</div>
    <button type="button" class="rail-btn active" title="${escapeHtml(appName)}" aria-current="page">App</button>
    <button type="button" class="rail-btn" title="CRM (placeholder)" disabled>CRM</button>
    <button type="button" class="rail-btn" title="Desk (placeholder)" disabled>Desk</button>
    <button type="button" class="rail-btn" title="Flow (placeholder)" disabled>Flow</button>
    <div class="rail-spacer"></div>
    <button type="button" class="rail-btn" id="theme-toggle" title="Toggle theme">◐</button>
  </aside>
  <div class="main">
    <div class="banner" role="status">
      <strong>Local shell</strong>
      <span class="grow">Sidebar chrome + real SDK bridge · in-memory storage (not the hosted platform)</span>
      <code id="app-url-label"></code>
    </div>
    <section class="card">
      <header class="topbar">
        <div class="crumbs">Apps / <strong id="app-name"></strong></div>
        <span class="chip" id="app-code"></span>
        <div class="grow"></div>
        <span class="nav-path" id="nav-hint" hidden></span>
        <span class="chip" id="theme-label">light</span>
      </header>
      <div class="iframe-wrap">
        <iframe
          id="app-frame"
          title="${escapeHtml(appName)}"
          sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"
        ></iframe>
      </div>
    </section>
  </div>
  <div id="toasts" aria-live="polite"></div>
  <script>
(function () {
  const APP_URL = ${escapeJs(appUrl)};
  const APP_CODE = ${escapeJs(appCode)};
  const APP_NAME = ${escapeJs(appName)};
  const TOKEN = 'local_preview_token';
  const API_BASE = 'http://localhost/local-preview';

  const frame = document.getElementById('app-frame');
  const themeLabel = document.getElementById('theme-label');
  const themeToggle = document.getElementById('theme-toggle');
  const navHint = document.getElementById('nav-hint');
  const toasts = document.getElementById('toasts');

  document.getElementById('app-name').textContent = APP_NAME;
  document.getElementById('app-code').textContent = APP_CODE;
  document.getElementById('app-url-label').textContent = APP_URL;

  let theme = 'light';
  let locale = 'en';
  let targetOrigin = '*';
  try { targetOrigin = new URL(APP_URL).origin; } catch (_) {}

  function tokenExpiresAt() {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  function postToApp(message) {
    const win = frame.contentWindow;
    if (!win) return;
    win.postMessage(message, targetOrigin);
  }

  function showToast(message, variant) {
    const el = document.createElement('div');
    el.className = 'toast' + (variant === 'success' || variant === 'error' ? ' ' + variant : '');
    el.textContent = message;
    toasts.appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  function setTheme(next) {
    theme = next === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    themeLabel.textContent = theme;
    postToApp({ type: 'weldapp:event', event: 'theme', payload: { value: theme } });
  }

  themeToggle.addEventListener('click', function () {
    setTheme(theme === 'light' ? 'dark' : 'light');
  });

  function initPayload() {
    return {
      appCode: APP_CODE,
      theme: theme,
      locale: locale,
      apiBaseUrl: API_BASE,
      token: TOKEN,
      tokenExpiresAt: tokenExpiresAt(),
      user: { id: 'usr_local_preview', name: 'Local Preview' },
      localPreview: true,
    };
  }

  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

    if (data.type === 'weldapp:ready') {
      postToApp({ type: 'weldapp:init', payload: initPayload() });
      return;
    }

    if (data.type === 'weldapp:request') {
      const id = data.id;
      const method = data.method;
      const payload = data.payload || {};
      try {
        let responsePayload = {};
        if (method === 'getToken') {
          responsePayload = {
            token: TOKEN,
            tokenExpiresAt: tokenExpiresAt(),
            apiBaseUrl: API_BASE,
          };
        } else if (method === 'navigate') {
          const to = payload.to;
          if (typeof to !== 'string' || !to.startsWith('/') || to.startsWith('//')) {
            throw new Error('Only platform-internal paths are allowed');
          }
          navHint.hidden = false;
          navHint.textContent = 'navigate → ' + to;
          responsePayload = { to: to };
        } else if (method === 'toast') {
          if (typeof payload.message === 'string') {
            showToast(payload.message, payload.variant || 'default');
          }
          responsePayload = {};
        } else {
          throw new Error('Unknown method: ' + String(method));
        }
        postToApp({ type: 'weldapp:response', id: id, ok: true, payload: responsePayload });
      } catch (err) {
        postToApp({
          type: 'weldapp:response',
          id: id,
          ok: false,
          error: { message: err && err.message ? err.message : 'Request failed' },
        });
      }
    }
  });

  frame.src = APP_URL;
})();
  </script>
</body>
</html>`;
}
