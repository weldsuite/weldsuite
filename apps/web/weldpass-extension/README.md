# WeldPass browser extension

A Chrome / Edge (Manifest V3) extension for the WeldPass team password manager.
It is a popup, nothing else: no content script, no background worker.

- **For this site** lists the logins saved for the page you are on, with a
  **Fill** button each.
- **Search** across every login you can open: copy the username, copy the
  password, copy the current 2FA code, open the site.
- **Save** stores what is typed in the page's login form as a new login.
- **Generator** makes a password and can put it into a sign-up or
  change-password form.

The extension has no login of its own. It reuses the session of the WeldSuite
web app in the same browser profile (Clerk's `syncHost`), and shows the logins
of the workspace that is active there. Passwords are decrypted by `pass-api`;
the extension asks for one only at the moment it fills or copies it.

## Environment

Vite env, read at build time. Copy `.env.example` to `.env.production` (used by
`build`) and/or `.env.development` (used by `dev`). None of the values are
secrets. The build succeeds without them and the popup then shows "Extension
not configured" with the names of what is missing.

| Variable | Required | What it is |
| --- | --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | yes | Publishable key of the Clerk instance the web app uses. |
| `VITE_SYNC_HOST` | yes | The host whose Clerk cookie carries the web session. See [Clerk configuration](#clerk-configuration): it is the web app's origin for a development instance and the Clerk Frontend API domain for a production one. |
| `VITE_API_URL` | yes | `app-api` origin, e.g. `https://app-api.weldsuite.org`. Requests go to `${VITE_API_URL}/api/weldpass/...`; app-api forwards them to `pass-api`. |
| `VITE_APP_URL` | no | The web app opened by "Open WeldSuite". Defaults to `VITE_SYNC_HOST`. Set it whenever the sync host is not the web app. |
| `VITE_EXTENSION_KEY` | no | Public key that pins the extension ID (the manifest's `key`). See below. |

`manifest.json` is generated at build time (`src/manifest/manifest.ts`), because
`host_permissions` must name exactly the hosts this build talks to.

## Build and load

```bash
pnpm install
pnpm --filter weldpass-extension build       # → apps/web/weldpass-extension/dist
pnpm --filter weldpass-extension dev         # rebuilds dist/ on change (no dev server)
pnpm --filter weldpass-extension test
pnpm --filter weldpass-extension type-check
```

Load it unpacked:

1. Chrome: `chrome://extensions` — Edge: `edge://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** and pick `apps/web/weldpass-extension/dist`.
4. Pin WeldPass to the toolbar. After a rebuild, press the reload icon on the
   extension's card.

The suggested shortcut for opening the popup is **Alt+Shift+P**. The browser
drops the suggestion if the combination is taken; set your own under
`chrome://extensions/shortcuts`.

## Clerk configuration

This was written against `@clerk/chrome-extension` **3.1.90**. What that version
needs, and where each requirement comes from:

1. **A stable extension ID.** The SDK's README (step 2, "Set a consistent
   extension key") requires it: Clerk identifies the extension by its
   `chrome-extension://<id>` origin, and an unpacked extension's ID otherwise
   depends on the folder it was loaded from. Generate a key pair once, put the
   base64 public key in `VITE_EXTENSION_KEY`, and note the ID Chrome shows for
   that build. (A Web Store listing has a fixed ID and key of its own.)

2. **Allow the extension's origin on the Clerk instance.** SDK README step 3:
   "Setting the `allowed_origins` is required for both Development and
   Production instances." One time per instance, with that instance's secret key:

   ```bash
   curl -X PATCH https://api.clerk.com/v1/instance \
     -H "Authorization: Bearer <CLERK_SECRET_KEY>" \
     -H "Content-type: application/json" \
     -d '{"allowed_origins": ["chrome-extension://<EXTENSION_ID>"]}'
   ```

   The call sets the list as a whole. If the instance already has allowed
   origins, send those along with the new one.

3. **Manifest permissions.** The SDK checks the manifest when it starts
   (`validateManifest` in its `dist/esm/chunk-RQHI25AD.js`) and throws without
   the `storage` permission, and — because `syncHost` is set — without the
   `cookies` permission and a `host_permissions` entry. Clerk's manifest guide
   (`packages/chrome-extension/docs/manifest.md` in clerk/javascript) lists the
   sync host and the Frontend API as the hosts to allow. The build derives the
   Frontend API host from the publishable key.

4. **`syncHost` on `<ClerkProvider>`.** The SDK reads one cookie from that host
   with `chrome.cookies.get`: `__client` for a production instance,
   `__clerk_db_jwt` for a development one. Clerk's sync-host guide
   (clerk.com/docs/guides/sessions/sync-host) gives the value per instance type:

   | Clerk instance | `VITE_SYNC_HOST` | `VITE_APP_URL` |
   | --- | --- | --- |
   | Development (`pk_test_…`), local | `http://localhost` | `http://localhost:3000` |
   | Development (`pk_test_…`), hosted test | `https://app-test.weldsuite.org` (inferred, see below) | not needed |
   | Production (`pk_live_…`) | `https://clerk.weldsuite.org` (the Frontend API domain) | `https://app.weldsuite.org` |

   The local and production rows follow Clerk's guide (production: "The value
   should be the domain that your Clerk Frontend API runs on"). The hosted-test
   row is an inference from how the SDK works — a development instance keeps
   `__clerk_db_jwt` on the web app's own host — and the guide does not cover
   it. None of the three has been tried against a WeldSuite Clerk instance.

Nothing needs to change in the Clerk Dashboard beyond the allowed origin: the
extension shows no Clerk sign-in UI, so no redirect URLs are involved.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Gives the popup the URL of the tab it was opened on, and access to that one tab, only after the user clicks the toolbar button or presses the shortcut. This is what stands in for a host permission on web pages. |
| `scripting` | `chrome.scripting.executeScript` runs the form reader/filler (`src/page/page-agent.ts`) in that tab — when the user presses **Fill**, opens **Save**, or presses **Fill into page**. Never on its own. |
| `storage` | Required by `@clerk/chrome-extension`, which keeps its client token in `chrome.storage.local`. The extension's own code stores nothing. |
| `cookies` | Required by `@clerk/chrome-extension` for `syncHost`: it reads the Clerk session cookie of the sync host. Limited to the hosts below. |
| host: `VITE_API_URL` | Calls to app-api from the popup. The API's CORS list (`packages/core/worker-kit/src/cors.ts`) has no extension origins and does not allow the `X-WeldPass-Client` header; a host permission is what exempts an extension page from CORS. |
| host: `VITE_SYNC_HOST` | The `cookies` API only returns cookies for hosts the extension has permission for. |
| host: Clerk Frontend API | Listed by Clerk's manifest guide for session sync; the SDK's requests to Clerk go there. |

There is deliberately **no** `<all_urls>`, no `content_scripts`, no `tabs`
permission and no background service worker. `src/manifest/manifest.test.ts`
fails the build's test run if any of those appear.

Copying uses `navigator.clipboard` from the focused popup, which needs no
`clipboardWrite` permission.

## Safety rules

Implemented in `src/lib/fill-policy.ts` and `src/lib/actions.ts`, tested in the
files next to them.

- A login is only filled into a page whose host satisfies
  `hostsMatch(item.host, hostOf(tabUrl))` — the same helper the API uses — and
  only on `https:` pages or `http://localhost`.
- That is checked when **Fill** is pressed, against the tab's URL at that
  moment: before the password is requested, again when it has arrived (using the
  item as the server returned it), and a third time inside the page, where the
  injected function refuses any origin other than the one that was validated.
- The password is requested only if the page shows a password field. On the
  first step of a two-step login the username from the list is filled and no
  reveal is made (or logged).
- A revealed password is a local variable for the length of one call. It is not
  put in `chrome.storage`, in a log, in module state or in React state. The two
  places a password is held in component state are the ones that must show it:
  the Save form and the generator. Both are gone when the popup closes.
- What the Save form reads from a page is treated as untrusted text: it only
  ever becomes the value of a React-rendered input.
- Only the page's origin is sent to the API for matching, not its path or query.
  A saved login stores origin and path, never the query string or fragment.
- Only the top frame is touched (`allFrames` is off).

## How filling works

`chrome.scripting.executeScript({ func: pageAgent, args })` serializes one
self-contained function and runs it in the tab's isolated world. It finds the
visible password field (never one marked `autocomplete="new-password"`), then
the username field: the nearest visible text / email / tel input before it in
the same form, preferring one marked `autocomplete="username"`. Values are set
through the native `HTMLInputElement` value setter followed by bubbling `input`
and `change` events, so React- and Vue-controlled forms pick them up.

Because the function is shipped as source text, it cannot use anything outside
its own body. `page-agent.test.ts` runs every case twice — once directly, once
on a copy rebuilt from `pageAgent.toString()` — to keep it that way.

## Icons

`public/icons/icon-{16,32,48,128}.png` are generated from
`apps/web/platform/public/assets/images/weldpass/icon.svg` and committed. To
regenerate after the source icon changes:

```bash
pnpm --filter weldpass-extension icons
```

## Known limitations

- **No "Save this password?" prompt** after you log in somewhere. Noticing a
  form submission needs a content script on every page, which is exactly the
  standing access this extension does not ask for. Saving is a click in the popup.
- **No inline autofill** (icons in fields, fill on page load) for the same reason.
- **Cross-origin iframes are not filled or read.** Login forms embedded from
  another origin are out of reach of `activeTab` on the top frame, and filling
  them would undo the host check.
- **Shadow DOM**: fields inside shadow roots are not found.
- **Two-step logins need two presses**: one for the username step, one for the
  password step.
- **Host matching has no public-suffix list.** `hostsMatch` treats a host and
  its subdomains as the same site, so a login saved for `example.github.io` is
  offered on `github.io` and vice versa. Shared with the API; changing it means
  changing `@weldsuite/app-api-client`.
- **The clipboard is not cleared.** There is no background worker to do it after
  the popup closes.
- **Signing out or switching workspace** in the web app is picked up the next
  time the popup opens, not while it is open.
- **Chromium only.** Firefox and Safari are not built or tested.
- **Bundle size**: about 2.6 MB unpacked, almost all of it Clerk's SDK (which
  bundles its UI even though none of it is shown).
