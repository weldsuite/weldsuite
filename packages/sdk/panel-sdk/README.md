# @weldsuite/panel-sdk

The browser SDK for WeldPanel, WeldSuite's product analytics: pageviews
(including single-page-app navigation), page leaves with scroll depth, clicks
and form submits, and your own custom events. Cookieless until the visitor
consents. About 5 KB gzipped. MIT licensed.

Phase 1 of WeldPanel: no `identify()`, user profiles or session recordings yet.

## Install

### Script snippet

Paste this before `</head>`, with your project token from WeldPanel →
Settings → Install:

```html
<script>
!function(w,p,s){p=w.weldpanel=w.weldpanel||{q:[]};if(!p.q)return;s=function(n){return function(){p.q.push([n,[].slice.call(arguments)])}};p.track=s("track");p.optOut=s("optOut");p.optIn=s("optIn");p.flush=s("flush");p.consent={grant:s("consent.grant"),revoke:s("consent.revoke")}}(window);
</script>
<script async src="https://pnl.weldsuite.org/s.js" data-project="wpk_…"></script>
```

The first script is a stub: it defines `window.weldpanel` straight away and
queues every call (`weldpanel.q`, as `[method, args]`) until the real script
has loaded, which then replays them. So your cookie banner can call
`weldpanel.consent.grant()` before the SDK has arrived, and nothing is lost.
Consent and opt-out calls from the queue are applied before the first
pageview; `track()` calls follow it. The stub is optional: without it, call
`window.weldpanel` only after the script has loaded.

The SDK reads the token from `data-project` and talks to the origin it was
loaded from. Add `data-debug` to the tag to see in the console why an event or
property was dropped.

The snippet is also exported, for install pages:
`import { installSnippet, STUB } from '@weldsuite/panel-sdk/install'`.

### npm

For apps that bundle their own code:

```ts
import { init } from '@weldsuite/panel-sdk';

const panel = init({ token: 'wpk_…' });
panel.track('Signed up', { plan: 'pro' });
```

`init({ token, host?, debug? })` returns at once. It fetches the project's
settings from the collector (`host`, default `https://pnl.weldsuite.org`) and
keeps the calls made in the meantime. On the server (no `window`) it returns a
client that does nothing, so it is safe to call during server rendering.

## API

The same on `window.weldpanel` and on what `init()` returns.

| Call | Does |
|---|---|
| `track(name, props?)` | A custom event. `name`: starts with a letter or digit, then letters, digits, spaces and `_ . : / -`, at most 100 characters; names starting with `$` are the SDK's own. `props`: a flat object, at most 50 keys, keys like identifiers (`plan`, `seat_count`), values strings (cut to 2048 characters), finite numbers, booleans or `null`. Invalid events and properties are dropped. |
| `consent.grant()` | The visitor agreed: from now on keep an anonymous id and a session id. |
| `consent.revoke()` | The visitor withdrew: delete the stored ids and go back to cookieless counting. |
| `optOut()` | Send nothing at all, on this page and on later visits, until `optIn()`. Deletes the stored ids. |
| `optIn()` | Undo `optOut()`. Consent goes back to the project's default (cookieless until `grant()`, unless the project needs no consent). |
| `flush()` | Send waiting events now. Returns a promise. |
| `version` | The SDK version. |

## Consent and what is stored

Every project has a consent mode, set in WeldPanel (ADR PANEL-006).

**Consent required** (the default, for sites with EU visitors). Until the site
calls `consent.grant()` the SDK is cookieless: it writes nothing to cookies,
localStorage or sessionStorage, and sends no visitor or session id. Visits are
still counted: the collector derives a daily-rotating anonymous hash on the
server, which cannot follow anyone across days. After `grant()` the SDK keeps,
in one localStorage key, `weldpanel:<project token>`:

- `a`: an anonymous id, `a_` + a random UUID;
- `s`: a session id, `s_` + a random UUID, replaced after 30 minutes without
  events;
- `t`: the time of the last event;
- `g`: whether the ids come from `grant()`.

The grant is remembered on later visits until `consent.revoke()` deletes the
key. Events already queued when consent changes are sent under the consent
they were collected with. A revoke or opt-out in one tab takes effect at once
in the site's other open tabs.

**No consent needed** (`consentMode: 'none'`, for sites that don't need it).
The SDK behaves as if `grant()` had been called from the start. If the project
later switches back to "consent required", ids that were not created by
`grant()` are deleted on the visitor's next page load.

**Global Privacy Control.** When the browser sends `navigator.globalPrivacyControl`,
the SDK counts the visitor cookielessly until the site calls `grant()`, in
both modes.

**Opt-out.** `optOut()` stores one flag, `weldpanel:optout`, and the SDK sends
nothing while it is set.

## What is collected

Every event has:

| Field | Value |
|---|---|
| `event_id` | A random UUID, so a retried batch is not counted twice |
| `ts` | When it happened (browser clock; the collector corrects for skew) |
| `url`, `title` | The page (URLs over 2048 characters lose their hash, then their query string) |
| `referrer` | `document.referrer`, on the first pageview of a page load only |
| `viewport_w` | The window width in CSS pixels |
| `anon_id`, `session_id` | Only with consent |

The collector adds country, region and city (from the IP, which is not
stored), device, browser and OS (from the user agent), and UTM parameters
(from the URL).

The events:

- **`$pageview`**: when the page loads, and on single-page-app navigation
  (`history.pushState` / `replaceState`, back and forward). Each URL counts
  once: a `replaceState` to the same URL or a jump to an anchor (`#faq`) is
  not a new page, a hash route (`#/settings`, `#!/settings`) is. A page
  restored from the back/forward cache counts again.
- **`$pageleave`**: when the visitor navigates away within the app or the page
  is hidden for good (`pagehide`), with `scroll_depth`: the furthest point
  seen, as a percentage of the page height.
- **`$autocapture`**: clicks on things people click to do something (links,
  buttons, submit and button inputs, `summary`, `[role=button|link|menuitem|tab]`)
  and form submits, when the project has autocapture on. It records:
  - `el.tag` and `el.selector`: the element and up to two ancestors, as tag,
    id and up to three class names (`section.hero > div.card > button.cta`);
  - `el.action`: `click` or `submit`;
  - `x`, `y`: the click position in the document (not for keyboard clicks or
    submits);
  - `el.text`, depending on the project's masking level: none with **strict**;
    with **balanced** and **relaxed**, the element's visible text, whitespace
    collapsed, cut to 255 characters, with email addresses and runs of four or
    more digits replaced by `*`. For a submit, the submit button's text.
- **Custom events** from `track()`, with their properties.

Never collected: what visitors type or pick. The SDK does not read the value
of any `input`, `textarea` or `select` (not even a submit button's label, which
is its value), and text inside those elements is skipped.

Per element:

- `data-panel-block`: clicks and submits on the element or inside it are not
  captured at all.
- `data-panel-mask`: the element's text is not sent (the click still is).

Pages matching the project's **excluded URLs** (patterns on the path, `*` for
any characters, for example `/admin/*`) send nothing: no pageview, page leave,
click or custom event.

## Sending

Events are queued and sent every 5 seconds, or as soon as 20 are waiting, as
`text/plain` JSON (no CORS preflight) to `POST {collector}/e`, in batches of at
most 100 events and 64 KiB. When the page is hidden or closed, the queue goes
out with `navigator.sendBeacon`, or `fetch` with `keepalive` where beacons are
missing or refused. A batch that fails to send because of a network error is
tried once more after a second or two. No cookies or credentials are sent.

## Development

```bash
pnpm --filter @weldsuite/panel-sdk test        # vitest, jsdom
pnpm --filter @weldsuite/panel-sdk type-check
pnpm --filter @weldsuite/panel-sdk build       # dist/panel.global.js, served by panel-ingest as /s.js
```

The build fails if the script is over 10 KB gzipped.

`src/wire.ts` is a plain copy of the collector's Zod schema
(`packages/domains/panel/src/wire.ts`), so the bundle carries no zod. Change
both together; `src/wire.contract.test.ts` checks them against each other.
`buildBatches()` (exported from the package root) is the function the
transport uses to turn events into request bodies, so the collector can test
what browsers will actually send:

```ts
import { buildBatches } from '@weldsuite/panel-sdk';

const [batch] = buildBatches({
  token: 'wpk_…',
  consent: false,
  events: [{ name: '$pageview', url: 'https://example.com/' }],
});
```
