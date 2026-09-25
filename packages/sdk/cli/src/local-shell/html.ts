/**
 * Lightweight WeldSuite-like host page for `weld app dev`.
 *
 * Realism over pixel-perfect parity: far-left app rail + content card +
 * postMessage bridge so the app-sdk uses the real iframe handshake (with
 * `localPreview: true` for in-memory storage).
 *
 * PROTOCOL SYNC WARNING: this page is a second implementation of the host
 * side of the bridge (protocol 2). Keep it in lockstep with
 * `packages/sdk/app-sdk/src/core/types.ts` and the platform host in
 * `apps/web/platform/app/weldapps/host/`.
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

/** JS string literal safe inside an inline <script> (no `</script>` breakout). */
function escapeJs(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
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
    .crumbs .sep { margin: 0 4px; opacity: 0.6; }
    .chip.dirty { border-color: var(--amber-border); color: var(--amber-fg); background: var(--amber-bg); }
    dialog#app-modal {
      width: min(720px, calc(100vw - 48px)); height: min(80vh, 760px);
      padding: 0; border: 1px solid var(--border); border-radius: 14px;
      background: var(--card); color: var(--fg);
      box-shadow: 0 24px 64px rgb(0 0 0 / 30%);
    }
    dialog#app-modal::backdrop { background: rgb(0 0 0 / 45%); }
    dialog#app-modal[data-size="sm"] { width: min(448px, calc(100vw - 48px)); }
    dialog#app-modal[data-size="lg"] { width: min(896px, calc(100vw - 48px)); }
    dialog#app-modal[data-size="xl"] { width: min(1152px, calc(100vw - 48px)); }
    .modal-inner { display: flex; flex-direction: column; height: 100%; }
    .modal-head { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 15px; }
    .modal-head .grow { flex: 1; }
    .modal-close { border: 0; background: transparent; color: var(--muted); font-size: 18px; cursor: pointer; }
    .modal-body { flex: 1; min-height: 0; position: relative; }
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
        <div class="crumbs" id="crumbs">Apps / <strong id="app-name"></strong></div>
        <span class="chip" id="app-code"></span>
        <span class="chip dirty" id="dirty-chip" hidden>Unsaved changes</span>
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
  <dialog id="app-modal">
    <div class="modal-inner">
      <div class="modal-head"><span id="modal-title"></span><span class="grow"></span><button type="button" class="modal-close" id="modal-close" aria-label="Close">×</button></div>
      <div class="modal-body"><iframe id="modal-frame" title="Modal" sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"></iframe></div>
    </div>
  </dialog>
  <div id="toasts" aria-live="polite"></div>
  <script>
(function () {
  const APP_URL = ${escapeJs(appUrl)};
  const APP_CODE = ${escapeJs(appCode)};
  const APP_NAME = ${escapeJs(appName)};
  const TOKEN = 'local_preview_token';
  const API_BASE = 'http://localhost/local-preview';
  const PROTOCOL = 2;

  // Approximations of the platform palette, pushed as design tokens so the
  // SDK UI kit reacts to theme changes the same way it does in WeldSuite.
  const DESIGN_TOKENS = {
    light: { background: '#ffffff', foreground: '#1a1d23', card: '#ffffff', 'card-foreground': '#1a1d23', primary: '#1f2937', 'primary-foreground': '#f9fafb', muted: '#f4f5f7', 'muted-foreground': '#6b7280', border: '#e5e7eb', input: '#e5e7eb', ring: '#9ca3af', radius: '0.625rem' },
    dark: { background: '#1c1d1f', foreground: '#ffffff', card: '#232529', 'card-foreground': '#ffffff', primary: '#266df0', 'primary-foreground': '#ffffff', muted: '#232529', 'muted-foreground': '#b5bdc9', border: '#2e3238', input: '#383e47', ring: '#709ff5', radius: '0.625rem' },
  };

  const frame = document.getElementById('app-frame');
  const modal = document.getElementById('app-modal');
  const modalFrame = document.getElementById('modal-frame');
  const modalTitle = document.getElementById('modal-title');
  const themeLabel = document.getElementById('theme-label');
  const themeToggle = document.getElementById('theme-toggle');
  const navHint = document.getElementById('nav-hint');
  const toasts = document.getElementById('toasts');
  const crumbsEl = document.getElementById('crumbs');
  const dirtyChip = document.getElementById('dirty-chip');

  document.getElementById('app-name').textContent = APP_NAME;
  document.getElementById('app-code').textContent = APP_CODE;
  document.getElementById('app-url-label').textContent = APP_URL;

  let theme = 'light';
  let locale = 'en';
  let dirty = false;
  let targetOrigin = '*';
  try { targetOrigin = new URL(APP_URL).origin; } catch (_) {}

  // Per-iframe context: the page frame, and the modal frame while open.
  const page = { el: frame, surface: 'page', path: '/', modal: null };
  let modalCtx = null;
  let pendingModal = null;

  function tokenExpiresAt() {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  function designTokens() {
    return { vars: DESIGN_TOKENS[theme] };
  }

  function post(ctx, message) {
    const win = ctx && ctx.el.contentWindow;
    if (!win) return;
    win.postMessage(message, targetOrigin);
  }

  function broadcast(message) {
    post(page, message);
    if (modalCtx) post(modalCtx, message);
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
    broadcast({ type: 'weldapp:event', event: 'theme', payload: { value: theme } });
    broadcast({ type: 'weldapp:event', event: 'designTokens', payload: { value: designTokens() } });
  }

  themeToggle.addEventListener('click', function () {
    setTheme(theme === 'light' ? 'dark' : 'light');
  });

  function setCrumbs(items) {
    crumbsEl.textContent = '';
    crumbsEl.append('Apps / ');
    const root = document.createElement('strong');
    root.textContent = APP_NAME;
    crumbsEl.appendChild(root);
    (Array.isArray(items) ? items.slice(0, 5) : []).forEach(function (item) {
      if (!item || typeof item.label !== 'string' || !item.label.trim()) return;
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      const label = document.createElement('span');
      label.textContent = item.label.slice(0, 80);
      crumbsEl.append(sep, label);
    });
  }

  window.addEventListener('beforeunload', function (event) {
    if (dirty) { event.preventDefault(); event.returnValue = ''; }
  });

  function initPayload(ctx) {
    return {
      appCode: APP_CODE,
      theme: theme,
      locale: locale,
      path: ctx.path,
      apiBaseUrl: API_BASE,
      // Protocol 2: the host never hands the app a token.
      token: null,
      tokenExpiresAt: null,
      user: { id: 'usr_local_preview', name: 'Local Preview' },
      localPreview: true,
      protocol: PROTOCOL,
      designTokens: designTokens(),
      surface: ctx.surface,
      modal: ctx.modal || undefined,
    };
  }

  function frameUrl(path) {
    try {
      const url = new URL(APP_URL);
      url.hash = path && path !== '/' ? path.replace(/^\\//, '') : '';
      return url.toString();
    } catch (_) {
      return APP_URL;
    }
  }

  function closeModal(outcome) {
    if (!modalCtx) return;
    const pending = pendingModal;
    modalCtx = null;
    pendingModal = null;
    if (modal.open) modal.close();
    modalFrame.removeAttribute('src');
    if (pending) pending(outcome);
  }

  document.getElementById('modal-close').addEventListener('click', function () {
    closeModal({ dismissed: true });
  });
  modal.addEventListener('cancel', function (event) {
    event.preventDefault();
    closeModal({ dismissed: true });
  });

  function handleRequest(ctx, method, payload) {
    if (method === 'getToken') {
      // Legacy SDKs (protocol 1) still ask for a token.
      return { token: TOKEN, tokenExpiresAt: tokenExpiresAt(), apiBaseUrl: API_BASE };
    }
    if (method === 'navigate') {
      const to = payload.to;
      if (typeof to !== 'string' || !to.startsWith('/') || to.startsWith('//')) {
        throw new Error('Only platform-internal paths are allowed');
      }
      navHint.hidden = false;
      navHint.textContent = 'navigate → ' + to;
      return { to: to };
    }
    if (method === 'toast') {
      if (typeof payload.message === 'string') showToast(payload.message, payload.variant || 'default');
      return {};
    }
    if (method === 'fetch') {
      // The SDK serves app-storage from memory in the local shell; other API
      // routes need the real platform (weld app dev --tunnel).
      const body = JSON.stringify({ error: { code: 'local_preview', message: 'The local shell has no WeldSuite API. Open the app in WeldSuite for live data.' } });
      return { status: 503, statusText: 'Service Unavailable', headers: [['content-type', 'application/json']], body: new TextEncoder().encode(body).buffer };
    }
    if (method === 'setBreadcrumbs') {
      if (ctx.surface === 'page') setCrumbs(payload.items);
      return {};
    }
    if (method === 'setDirty') {
      if (ctx.surface === 'page') {
        dirty = payload.dirty === true;
        dirtyChip.hidden = !dirty;
      }
      return {};
    }
    if (method === 'confirm') {
      if (typeof payload.title !== 'string' || !payload.title.trim()) throw new Error('confirm() needs a title');
      const text = [payload.title, payload.description].filter(Boolean).join('\\n\\n');
      return { confirmed: window.confirm(text) };
    }
    if (method === 'openModal') {
      if (ctx.surface !== 'page') throw new Error('A modal cannot open another modal');
      if (modalCtx) throw new Error('A modal is already open');
      const path = payload.path;
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
        throw new Error('openModal() needs an app-relative path');
      }
      modalCtx = { el: modalFrame, surface: 'modal', path: path, modal: { title: payload.title, params: payload.params } };
      modal.setAttribute('data-size', payload.size || 'md');
      modalTitle.textContent = typeof payload.title === 'string' && payload.title ? payload.title : APP_NAME;
      modalFrame.src = frameUrl(path);
      modal.showModal();
      return new Promise(function (resolve) { pendingModal = resolve; });
    }
    if (method === 'closeModal') {
      if (ctx.surface !== 'modal') throw new Error('closeModal() is only available inside a modal');
      setTimeout(function () { closeModal({ dismissed: false, result: payload.result }); }, 0);
      return {};
    }
    throw new Error('Unknown method: ' + String(method));
  }

  window.addEventListener('message', function (event) {
    const ctx = event.source === frame.contentWindow ? page : (modalCtx && event.source === modalFrame.contentWindow ? modalCtx : null);
    if (!ctx) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

    if (data.type === 'weldapp:ready') {
      post(ctx, { type: 'weldapp:init', payload: initPayload(ctx) });
      return;
    }

    if (data.type === 'weldapp:notify') {
      if (data.event === 'shortcut' && data.payload && typeof data.payload.key === 'string') {
        showToast('⌘/Ctrl+' + data.payload.key.toUpperCase() + ' → handled by WeldSuite', 'default');
      }
      return;
    }

    if (data.type === 'weldapp:request') {
      const id = data.id;
      Promise.resolve()
        .then(function () { return handleRequest(ctx, data.method, data.payload || {}); })
        .then(function (responsePayload) {
          post(ctx, { type: 'weldapp:response', id: id, ok: true, payload: responsePayload });
        })
        .catch(function (err) {
          post(ctx, {
            type: 'weldapp:response',
            id: id,
            ok: false,
            error: { message: err && err.message ? err.message : 'Request failed' },
          });
        });
    }
  });

  frame.src = APP_URL;
})();
  </script>
</body>
</html>`;
}
