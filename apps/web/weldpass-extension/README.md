# WeldPass browser extension

A Chrome / Edge (Manifest V3) extension for the WeldPass team password
manager (ADR PASS-009, which replaced the popup-only PASS-008).

- **Inline menus.** A WeldPass icon in login, sign-up and one-time-code
  fields opens a menu with the logins saved for that site. Picking one fills
  it. On a one-time-code field the menu offers the current 2FA code; on a
  sign-up or change-password field, a generated password.
- **Save and update.** After a login form is submitted, a bar on the next
  page offers to save the login, update the saved password, or never ask for
  that site.
- **The toolbar popup**: search every login (copy the username, password or
  2FA code, open the site), Fill / Save on the current tab, the generator, and
  the workspace switcher.
- **Settings** (`settings.html`, also the options page): the server, inline
  menus and save prompts on or off, the sites where they never show, and
  signing out.

## Sign-in, server and workspace

The extension is a WeldID public client of its own, `weldsuite-extension`
(authorization code with PKCE, refresh tokens, audience `weldsuite-api`). The
server names it in `/config.json` as `auth.extensionClientId`
(`OIDC_EXTENSION_CLIENT_ID`).

- The OIDC session runs in the **service worker** (`src/background/`), the
  only part that holds tokens or calls the API. It is the mobile apps' session
  (`@weldsuite/mobile-platform/oidc-session`) with the browser plugged in:
  `chrome.identity.launchWebAuthFlow` opens WeldID's sign-in in its own window
  and comes back to `https://<extension id>.chromiumapp.org/`. The popup can't
  run the flow: it closes when that window takes focus.
- The refresh token is in `chrome.storage.local`, the access token in
  `chrome.storage.session` (memory only). Signing out revokes the refresh
  token, and the next sign-in shows WeldID's form (`prompt=login`).
- **Server:** `https://app.weldsuite.eu` by default. Settings → "Use your own
  server" takes an address, asks for host access to it, reads its
  `/config.json` (it must be the Rust backend with OIDC sign-in, offer
  `pass` and name an `extensionClientId`), asks for host access to its
  sign-in server too, and switches.
- **Workspace:** in header mode (WeldID) the workspace list is
  `GET /api/workspaces`; a sole workspace is picked without asking; the choice
  is remembered and sent as `X-Weld-Workspace` on every request. In claim mode
  (Zitadel) the token names the workspace.

### Extension ids and WeldID

Every id that signs in must have its redirect, `https://<id>.chromiumapp.org/`
(trailing slash included: WeldID matches redirects exactly), on the
`weldsuite-extension` client in
`rust/deploy/flux/infrastructure/weldid/values/weldid.yaml`.

| Build | Id | Key |
| --- | --- | --- |
| Development, test, Playwright | `nlmnjlkgeoeklbahlemmlcfnlfgdimnp` | `src/manifest/dev-key.ts` (public half; the private half isn't needed and isn't in the repo) |
| Chrome Web Store | not yet created | the store's |
| Edge Add-ons | not yet created | the store's |

A self-hosted install with Zitadel adds the same redirects to a User Agent
application (`rust/deploy/hetzner/README.md`, step 7 "2d").

## Build and load

```bash
pnpm install
pnpm --filter weldpass-extension build       # → apps/web/weldpass-extension/dist
pnpm --filter weldpass-extension dev         # rebuilds dist/ on change (no dev server)
pnpm --filter weldpass-extension test        # unit tests
pnpm --filter weldpass-extension type-check
pnpm --filter weldpass-extension zip         # the store zip, see store/README.md
```

Load it unpacked: `chrome://extensions` (or `edge://extensions`), turn on
**Developer mode**, **Load unpacked**, pick `apps/web/weldpass-extension/dist`.
After a rebuild, press the reload icon on its card. The suggested shortcut
for the popup is **Alt+Shift+P** (`chrome://extensions/shortcuts`).

Optional build settings (`.env.example`; none are secrets):

| Variable | What it does |
| --- | --- |
| `VITE_DEFAULT_SERVER`, `VITE_DEFAULT_ISSUER` | Another default server and its sign-in server, e.g. EU test (`https://app.test.weldsuite.eu`, `https://auth.test.weldsuite.eu`). The manifest's host permissions follow. |
| `VITE_EXTENSION_KEY` | Another public key to pin the id with, instead of the development key. Ignored by the store build. |

`manifest.json` is generated at build time (`src/manifest/manifest.ts`). The
content script is a separate IIFE build (`content.js`), because content
scripts can't be ES modules; the pages and the module service worker
(`background.js`) are one Vite build.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | The session, the server and workspace choice, the settings. Pending saves and open menus in `chrome.storage.session` (memory only). |
| `identity` | `launchWebAuthFlow`: the WeldID sign-in. |
| `scripting` | The popup's Fill / Save / generator on the active tab, and the content script for tabs open at install. |
| `activeTab` | The popup's tab URL, without `tabs`. |
| host: `https://app.weldsuite.eu/*`, `https://auth.weldsuite.eu/*` | The default server's API and sign-in. |
| optional host: `https://*/*`, `http://localhost/*` | A self-hosted server and its sign-in server, asked for when chosen. |
| content script: `https://*/*`, `http://localhost/*`, all frames | Inline icons and menus, filling, noticing a submitted login. |
| web accessible: `menu.html`, `prompt.html`, `use_dynamic_url` | The inline menu and the save bar, framed into pages. |

No `tabs`, `cookies`, `<all_urls>`, `webRequest`, `externally_connectable` or
remote code. `src/manifest/manifest.test.ts` asserts this exact set and fails
on any change until PASS-009 is amended. The store wording is in
[`store/permissions.md`](store/permissions.md).

## Safety rules

- **Only the worker holds tokens and calls the API.** It answers each message
  by its sender (`src/background/senders.ts`), never by what the message says:
  a content script can't ask for anything that reveals a password; the menu
  and the bar can act only for a nonce registered in their own tab. Web pages
  can't message the extension at all.
- **Fill policy** (`src/lib/fill-policy.ts`, shared with the API through
  `hostOf` / `hostsMatch`): `https:` or `http://localhost` only, and the
  frame's own host must match the login's. The worker checks it before the
  reveal (on the item as matched) and after it (on the item as revealed); the
  frame checks it once more, and refuses any origin other than the one the
  worker validated, before filling. A cross-origin frame is filled only when
  its own origin matches, and the menu names that origin.
- **The page can't read the menu or the bar.** Both are extension pages in
  iframes inside closed shadow roots; their size is fixed per kind, so it
  doesn't tell a page how many logins there are.
- **Clickjacking** (`src/frames/guard.ts`): a pick counts only as a trusted
  click inside the menu frame, while IntersectionObserver v2 says the frame is
  fully visible and unobscured, after it has been so for 500 ms; the menu is
  shown in the top layer (a popover). A browser without `trackVisibility`
  gets no clickable menu.
- **A password reaches a frame only after a pick**, for that frame and
  document alone (`chrome.tabs.sendMessage` with `frameId` and `documentId`),
  bound to the menu's nonce. On the first step of a two-step login only the
  username is filled, with no reveal.
- **Pending saves** stay in `chrome.storage.session`, per tab, for at most
  five minutes, and are dropped on sign-out, server change or tab close. The
  bar shows the site and username, never the password. A record of what was
  filled keeps a salted hash of the password, never the password, so
  submitting exactly that login asks nothing.
- Nothing logs a password or a message's contents. Only the page's origin is
  sent for matching, never its path or query; a saved login keeps origin and
  path.

## Tests

- Unit (`pnpm --filter weldpass-extension test`, also on every PR in CI):
  form detection (`src/content/detect.test.ts`), the fill policy, the save
  queue, the worker against a fake server (`src/background/worker.test.ts`),
  sender rules, the session adapters, server choice, settings and the
  manifest. The shared session has its own tests in
  `packages/clients/mobile-platform`.
- Playwright (`pnpm --filter weldpass-extension test:e2e`, once
  `pnpm --filter weldpass-extension exec playwright install chromium`): loads
  the unpacked extension into Chromium against local login pages and a fake
  WeldSuite server and issuer (`e2e/fake-server.ts`): sign-in, an inline fill,
  a cross-origin frame, a refused fill for another host, save, update, and no
  prompt after an unchanged fill. It runs on every release tag.

## Release

[`store/README.md`](store/README.md): a tag `weldpass-extension-v<version>`
builds the store zip in CI; a person uploads it.

## Icons

`public/icons/icon-{16,32,48,128}.png` are generated from
`apps/web/platform/public/assets/images/weldpass/icon.svg`:
`pnpm --filter weldpass-extension icons`.

## Known limitations

- **Chromium only.** Firefox would need its own identity redirect domain;
  Safari isn't built.
- **Closed shadow roots** are not searched for fields (open ones are).
- **Cards and secure notes** aren't offered by the extension, only logins.
- **The clipboard is not cleared** after a copy from the popup.
- **Host matching** is `hostsMatch` from `@weldsuite/app-api-client`, shared
  with the API; public-suffix awareness lands there (plan
  `weldpass-eu.md`, 1.6), not here.
- **The content script carries Zod** (about 50 KB of its 80 KB), because the
  shared host helpers live in a module with the WeldPass schemas.
