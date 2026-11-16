# @weldsuite/panel-sdk

The SDK for WeldPanel, WeldSuite's product analytics. In the browser:
pageviews (including single-page-app navigation), page leaves with scroll
depth, clicks and form submits, your own custom events, identified users and
their profiles, frustration signals (rage clicks, dead clicks, quick backs,
excessive scrolling, JavaScript errors) and, with a separate plugin, session
recordings. On your server: events, profiles and historical imports with a
secret key. Cookieless until the visitor consents. The browser script is about
9 KB gzipped; the recording plugin, about 25 KB, is only downloaded for
sessions that are recorded. MIT licensed.

## Install

### Script snippet

Paste this before `</head>`, with your project token from WeldPanel →
Settings → Install:

```html
<script>
!function(w,p,s){p=w.weldpanel=w.weldpanel||{q:[]};if(!p.q)return;s=function(n){return function(){p.q.push([n,[].slice.call(arguments)])}};p.track=s("track");p.identify=s("identify");p.reset=s("reset");p.optOut=s("optOut");p.optIn=s("optIn");p.flush=s("flush");p.consent={grant:s("consent.grant"),revoke:s("consent.revoke")};p.people={set:s("people.set"),set_once:s("people.set_once"),unset:s("people.unset"),increment:s("people.increment")}}(window);
</script>
<script async src="https://pnl.weldsuite.org/s.js" data-project="wpk_…"></script>
```

The first script is a stub: it defines `window.weldpanel` straight away and
queues every call (`weldpanel.q`, as `[method, args]`) until the real script
has loaded, which then replays them. So your cookie banner can call
`weldpanel.consent.grant()`, and your app `weldpanel.identify(…)`, before the
SDK has arrived, and nothing is lost. Consent, opt-out, `identify()` and
`reset()` calls from the queue are applied before the first pageview, in the
order they were made; `track()` and `people.*` calls follow it. The stub is
optional: without it, call `window.weldpanel` only after the script has loaded.

The SDK reads the token from `data-project` and talks to the origin it was
loaded from. Add `data-debug` to the tag to see in the console why an event,
property or call was dropped.

The snippet is also exported, for install pages:
`import { installSnippet, STUB } from '@weldsuite/panel-sdk/install'`.

### npm

For apps that bundle their own code:

```ts
import { init } from '@weldsuite/panel-sdk';

const panel = init({ token: 'wpk_…' });
panel.track('Signed up', { plan: 'pro' });
```

`init({ token, host?, debug?, recorder? })` returns at once. It fetches the
project's settings from the collector (`host`, default
`https://pnl.weldsuite.org`) and keeps the calls made in the meantime. On the
server (no `window`) it returns a client that does nothing, so it is safe to
call during server rendering. For `recorder`, see "Session recordings".

## API

The same on `window.weldpanel` and on what `init()` returns.

| Call | Does |
|---|---|
| `track(name, props?)` | A custom event. `name`: starts with a letter or digit, then letters, digits, spaces and `_ . : / -`, at most 100 characters; names starting with `$` are the SDK's own. `props`: a flat object, at most 50 keys, keys like identifiers (`plan`, `seat_count`), values strings (cut to 2048 characters), finite numbers, booleans or `null`. Invalid events and properties are dropped. |
| `identify(userId)` | Who the visitor is: your user id (1 to 255 characters, no control characters). Sends one `$identify` event linking the browser's anonymous id to the user, then adds `user_id` to every event, also on later visits. Calling it again with the same id does nothing; with a different id, it first does a `reset()`, so two people sharing a browser don't merge. Needs consent. |
| `reset()` | Forget the user id and start a new anonymous id and session. Call it when someone logs out. |
| `people.set(props)` | Set properties on the identified user's profile. `email` and `name` are the profile's own `$email` and `$name`; `$avatar` and `$created` can be set too. Same value rules as `track()`. |
| `people.set_once(props)` | Only the properties the profile doesn't have yet. |
| `people.unset(key or keys)` | Remove properties. |
| `people.increment(key, by = 1)` or `people.increment({ key: by })` | Add to numeric properties (negative to subtract). |
| `consent.grant()` | The visitor agreed: from now on keep an anonymous id and a session id. |
| `consent.revoke()` | The visitor withdrew: delete everything stored and go back to cookieless counting. |
| `optOut()` | Send nothing at all, on this page and on later visits, until `optIn()`. Deletes everything stored. |
| `optIn()` | Undo `optOut()`. Consent goes back to the project's default (cookieless until `grant()`, unless the project needs no consent). |
| `flush()` | Send waiting events now. Returns a promise. |
| `version` | The SDK version. |

`identify()` and the `people` calls need consent (or a project that needs
none) and are dropped without it, and `people` calls need `identify()` first.
Profile updates are sent with the next batch of events, never on their own.

## Consent and what is stored

Every project has a consent mode, set in WeldPanel (ADR PANEL-006).

**Consent required** (the default, for sites with EU visitors). Until the site
calls `consent.grant()` the SDK is cookieless: it writes nothing to cookies,
localStorage or sessionStorage, sends no visitor, session or user id, drops
`identify()` and `people` calls, and doesn't load the recording plugin. Visits
are still counted: the collector derives a daily-rotating anonymous hash on
the server, which cannot follow anyone across days. Frustration signals and
errors are counted cookielessly too, like pageviews.

After `grant()` the SDK keeps:

- localStorage `weldpanel:<project token>`:
  - `a`: an anonymous id, `a_` + a random UUID;
  - `s`: a session id, `s_` + a random UUID, replaced after 30 minutes without
    events;
  - `t`: the time of the last event;
  - `g`: whether the ids come from `grant()`;
  - `u`: the user id from `identify()`, if any.
- localStorage `weldpanel:<project token>:rec`, only for projects that record
  sessions: whether this session is recorded and the number of the next
  recording chunk, shared by the session's tabs.
- sessionStorage `weldpanel:<project token>`: this tab's last page (to spot
  quick backs across page loads), the errors already reported this session,
  and the heatmap page groups already snapshotted.

The grant is remembered on later visits until `consent.revoke()` deletes all
of it. Events already queued when consent changes are sent under the consent
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
| `user_id` | Only with consent, after `identify()` |

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
  - `x`, `y`: the click position in the document, and `rel_x`, `rel_y`: where
    in the element's box it landed, from 0 to 1, for heatmaps (not for
    keyboard clicks or submits);
  - `el.text`, depending on the project's masking level: none with **strict**;
    with **balanced** and **relaxed**, the element's visible text, whitespace
    collapsed, cut to 255 characters, with email addresses and runs of four or
    more digits replaced by `*`. For a submit, the submit button's text.
- **`$identify`**: from `identify()`, with `anon_id` and `user_id`.
- **Frustration signals**, worked out in the browser:

  | Event | When | Carries |
  |---|---|---|
  | `$rageclick` | 3 or more clicks within 700 ms and 30 px of each other (once per burst) | `el`, `x`, `y`, `rel_x`, `rel_y` |
  | `$deadclick` | a click on something that looks clickable (a link, a button, `[role=button]`, a submit or button input, `[onclick]`, or anything with `cursor: pointer`) after which, for 1 second, the page doesn't change, navigate, start a request (`fetch` or XHR), move focus or scroll. Fields, labels, downloads, `mailto:` / `tel:` links and clicks with a modifier key don't count. | `el`, `x`, `y`, `rel_x`, `rel_y` |
  | `$quickback` | back on the previous page within 7 seconds (in a single-page app, and across full page loads with consent) | `props.$from`: the path left |
  | `$excessivescroll` | the scroll direction changes 4 or more times while scrolling past 3 window heights, within 20 seconds (once per page) | `scroll_depth` |
  | `$exception` | an uncaught error or unhandled promise rejection; each message, script and line once per session (at most 20 a page load) | `error_message` (emails and long numbers masked), `props.$source` (the script URL without its query), `props.$line`, `props.$col` |

  Rage and dead clicks are click capture, so they follow the project's
  autocapture setting. The dead-click check observes the page only for the
  second after such a click; to see requests it wraps `window.fetch` and
  `XMLHttpRequest.prototype.send`, which only note the time (the SDK's own
  requests don't count).
- **Custom events** from `track()`, with their properties.

Never collected: what visitors type or pick. The SDK does not read the value
of any `input`, `textarea` or `select` (not even a submit button's label, which
is its value), and text inside those elements is skipped.

Per element:

- `data-panel-block`: clicks and submits on the element or inside it are not
  captured at all, and recordings show an empty box of the same size.
- `data-panel-mask`: the element's text is not sent (the click still is), and
  recordings mask its text and fields.
- `data-panel-unmask`: recordings show the element's text and fields even
  where the masking level would mask them (never a password).

Pages matching the project's **excluded URLs** (patterns on the path, `*` for
any characters, for example `/admin/*`) send nothing: no pageview, page leave,
click, custom event, identity link, profile update, frustration signal or
recording.

## Session recordings

When the project records sessions, the SDK loads the recording plugin, rrweb's
`record()` (MIT), from `{collector}/rec.js`, only when all of these hold:

- the visitor has consented (or the project needs no consent);
- the session is sampled: decided once per session, at the project's sample
  rate, and kept with the session so every tab and page of it agrees;
- the project's quota and settings allow recordings;
- the page isn't excluded (recording stops on an excluded page and starts again
  after it);
- the browser has `CompressionStream` (otherwise nothing is recorded).

Apps that bundle the SDK can bundle the plugin too, instead of loading it from
the collector:

```ts
import { init } from '@weldsuite/panel-sdk';
import { createRecorder } from '@weldsuite/panel-sdk/recorder';

init({ token: 'wpk_…', recorder: createRecorder });
```

Masking follows the project's masking level:

| Level | Text | Fields | Images |
|---|---|---|---|
| **strict** | masked | masked | blocked |
| **balanced** (default) | visible | masked | visible |
| **relaxed** | visible | only passwords, card fields (`autocomplete="cc-…"`) and fields inside `data-panel-mask` masked | visible |

At every level: password fields are always masked (also after a "show
password" toggle), `data-panel-mask` / `data-panel-unmask` / `data-panel-block`
adjust per element, and canvas, video and audio, cross-origin iframes, fonts
and scripts are not recorded. Masked text keeps its shape (`****`), so the
layout replays as it was.

Recordings are sent in chunks, gzipped, to `POST {collector}/r`: every 10
seconds, at about 64 KB of events, when the tab is hidden and on page hide.
Each page view starts with a full snapshot (a new chunk). Only the visible tab
records: hidden, it sends what it has and stops; shown again, it starts over
with a full snapshot. After 30 minutes without input the recording pauses
until the visitor's next event.

**Heatmap backgrounds.** When the project asks for one (a page group and device
class without a recent recording), the next consented visitor on a matching
page and device class sends one masked full snapshot of it to
`POST {collector}/snap`, two seconds after the page is shown, at most once per
page group per browser session. This loads the plugin even when the session
isn't recorded.

## Server

```ts
import { createPanelServer } from '@weldsuite/panel-sdk/server';

const panel = createPanelServer({ secretKey: process.env.WELDPANEL_SECRET_KEY! });

panel.track({ name: 'Subscription renewed', distinctId: user.id, userId: user.id, props: { plan: 'pro' } });
panel.identify({ userId: user.id, anonId }); // the browser's anonymous id, e.g. sent along at sign-up
panel.people.set(user.id, { email: user.email, plan: 'pro' });
panel.people.increment(user.id, 'renewals');
await panel.flush();

await panel.import(historicalOrders.map((o) => ({ name: 'Order placed', distinctId: o.customerId, timestamp: o.createdAt })));
```

Plain `fetch`, so it runs on Node 18+, Cloudflare Workers, Deno and Bun.
Create a secret key (`wps_…`) in WeldPanel; keep it on the server.

| Call | Does |
|---|---|
| `createPanelServer({ secretKey, collectorUrl?, fetch?, onError? })` | A client. `collectorUrl` defaults to `https://pnl.weldsuite.org`. |
| `track({ name, distinctId, userId?, anonId?, url?, title?, props?, timestamp?, eventId? })` | Queue an event. `distinctId` is required: whoever you count as the visitor. Timestamps up to 7 days old. `eventId` (8 to 64 characters) makes a repeat count once. |
| `identify({ userId, anonId })` | Link a browser's anonymous id to a user, like the browser's `identify()`. |
| `people.set` / `set_once` / `unset` / `increment` | As in the browser, with the user id first: `people.set(userId, props)`. |
| `flush()` | Send what is queued, 100 events and 50 profile updates a request, to `POST /v1/track`. Resolves to `{ accepted, dropped }`; rejects with a `PanelServerError` (`status`, `code`) when the collector refuses, e.g. 401 for a bad or revoked key. |
| `import(events)` | Historical events (timestamps up to 5 years old), sent now in requests of 1000 to `POST /v1/import`. Resolves to `{ accepted, dropped }`. |

Events are sent when you call `flush()`, or as soon as 100 are waiting (a
failure of that send goes to `onError`, by default `console.error`). Call
`flush()` before the process or request ends, for example
`ctx.waitUntil(panel.flush())` on Workers. A network failure, a 429 or a 5xx is
retried once after a second. Server events get no location or device
enrichment.

## Sending

Events are queued and sent every 5 seconds, or as soon as 20 are waiting, as
`text/plain` JSON (no CORS preflight) to `POST {collector}/e`, in batches of at
most 100 events, 50 profile updates and 64 KiB. When the page is hidden or
closed, the queue goes out with `navigator.sendBeacon`, or `fetch` with
`keepalive` where beacons are missing or refused. A batch that fails to send
because of a network error is tried once more after a second or two. No
cookies or credentials are sent.

## Development

```bash
pnpm --filter @weldsuite/panel-sdk test        # vitest, jsdom
pnpm --filter @weldsuite/panel-sdk type-check
pnpm --filter @weldsuite/panel-sdk build       # dist/panel.global.js (/s.js) and dist/panel-recorder.global.js (/rec.js)
```

The build fails if the core script is over 10 KB gzipped, or the recording
plugin over 80 KB. panel-ingest imports both bundles as text and serves them.

`src/wire.ts` is a plain copy of the collector's Zod schema
(`packages/domains/panel/src/wire.ts`), so the bundle carries no zod. Change
both together; `src/wire.contract.test.ts` checks them against each other,
including what the browser client and the server client actually send.
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
