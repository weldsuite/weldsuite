# desktop

Electron shell around the platform SPA. One codebase: the desktop app loads the
live platform web app and layers native integrations on top (screen share, tray,
OS notifications, deep links, auto-update, badge count).

## Stack

- Electron 42 + electron-vite (dev loop) + electron-builder (packaging)
- Ships Chromium → identical `getDisplayMedia` behavior across OS
- Auto-update via `electron-updater` (generic provider at
  `https://downloads.weldsuite.eu`, set in `electron-builder.yml`)
- Deep-link scheme: `weldsuite://…`

## Servers

The shell opens **WeldSuite EU** (`https://app.weldsuite.eu`) unless someone
picked another server (`src/main/server.ts`):

1. `DESKTOP_APP_URL`, for development (any origin; the server can't be changed
   in the app then);
2. the server picked under **Change server…**, kept in `server.json` in the
   user data folder;
3. `http://localhost:3000` under `pnpm dev`;
4. WeldSuite EU.

**Change server…** is in the tray menu, the macOS app menu, Settings →
Desktop in the platform (`openServerSettings` on the bridge) and on the
can't-reach page. It opens a window of the shell's own (`src/renderer/server`,
with its own preload) where a person picks WeldSuite EU or types another
server's address: a self-hosted install or a test cluster. The shell keeps an
address only after its `/config.json` answers with an OIDC issuer, which
Global's app (`app.weldsuite.org`, being retired) doesn't, so it is refused.
No page can change the server: the window's IPC answers that window only, and
`server.json` is outside the settings the page writes.

When the server doesn't answer (offline, DNS, TLS), the view shows
`src/renderer/offline` instead of an empty window: **Try again**, **Change
server…**, and a retry as soon as the machine is back online. Both pages are
in English and Dutch, by the system language (`src/renderer/shared/strings.ts`;
the tray's words are in `src/main/strings.ts`).

## Dev

```bash
# Start platform (port 3000) in another shell:
pnpm --filter platform dev

# Start desktop shell pointing at localhost:3000
pnpm --filter desktop dev
```

Point it at another server with `DESKTOP_APP_URL`:

```bash
DESKTOP_APP_URL=https://app.test.weldsuite.eu pnpm --filter desktop dev
```

## Package

```bash
pnpm --filter desktop package:win     # NSIS installer (x64 + arm64)
pnpm --filter desktop package:mac     # DMG + zip (universal)
pnpm --filter desktop package:linux   # AppImage + deb
pnpm --filter desktop package:store   # Microsoft Store .appx (x64 + arm64), see below
```

Artifacts land in `release/`.

## Icons

Drop these before packaging:

- `assets/icon.ico` (Windows, 256×256 multi-size)
- `assets/icon.icns` (macOS)
- `assets/icon.png` (Linux, 512×512)
- `resources/trayTemplate.png` (tray; macOS expects a template image, black
  with alpha, `@2x` variant recommended)
- `assets/appx/*` (the Microsoft Store package's tiles and logos), made from
  `assets/icon.png` by `pnpm --filter desktop icons:store`

## Platform-side integration

The preload script exposes `window.weldsuiteDesktop` when running inside the
shell. The platform app should feature-detect and fall back gracefully:

```ts
if (window.weldsuiteDesktop?.isDesktop) {
  await window.weldsuiteDesktop.setBadgeCount(unreadCount);
}
```

Typings live at `apps/web/platform/types/weldsuite-desktop.d.ts` and must stay
in lockstep with `src/preload/index.ts`.

Sign-in goes through the system browser on every edition
([`docs/auth-handoff.md`](docs/auth-handoff.md)): a Clerk ticket by deep link
on Global, and on the OIDC editions (EU, self-hosted) a loopback redirect to
`src/main/loopback-sign-in.ts` (`oidcSignIn` on the bridge, 0.3.0 and later).
`pnpm --filter desktop test` runs the main process's unit tests.

The platform is served live, so it also runs inside **every shell already
installed**, including ones older than the preload you're editing. A bridge
method added after a shell release must be optional in the platform typings
and feature-detected before use (`typeof desktop?.foo === 'function'`);
calling a missing one from a root-level component leaves the whole app on the
"Something went wrong" screen. Bump `version` in `package.json` for every
release too: electron-updater only offers an update to a higher version, so a
release with an unchanged version never reaches existing installs.

## Screen sharing (WeldMeet / WeldChat)

The call SDK (RealtimeKit) calls `getDisplayMedia()` **itself** inside
`enableScreenShare()`, so the platform never sees the request and can't wrap
it. The shell intercepts it instead, in `setDisplayMediaRequestHandler`:

1. User clicks "Share screen"; the SDK calls `getDisplayMedia()`
2. **macOS 15+ / Wayland**: `useSystemPicker: true` routes the request to the
   OS picker and the shell's handler never runs. Nothing else to do.
3. **Everywhere else** (Windows, older macOS, X11): Electron invokes the
   handler. It enumerates sources and asks the app to choose one, over IPC.
4. The platform's `<DesktopSourcePicker />` (mounted in
   `apps/web/platform/src/routes/__root.tsx`) renders the modal and replies
   with a source id — or `null` to cancel.
5. The shell resolves the capture request with the matching source.

**Anything other than an explicit choice denies the request**: no picker
mounted, a cancel, an unknown source id, or a 2-minute timeout. `callback({})`
makes `getDisplayMedia` reject exactly as a cancelled browser picker does,
which the call contexts already handle.

Never auto-select a source in that handler. It runs *before* any consent UI,
so picking one starts capturing the user's screen without asking — which is
what the old `sources[0]` fallback did on every non-macOS machine.

`getDesktopSources()` stays on the bridge for callers that want to enumerate
sources themselves; the picker flow above does not use it.

On macOS the first attempt triggers the system Screen Recording permission
prompt, make sure the app is signed + notarized or the permission will not
persist across restarts.

## Code signing

- **Windows**: set `CSC_LINK` + `CSC_KEY_PASSWORD` env vars (base64 PFX + pass)
  or configure `certificateFile` in `electron-builder.yml`.
- **macOS**: set `CSC_LINK` + `CSC_KEY_PASSWORD` for the Developer ID cert, and
  `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` for notarization.

## Releases and auto-update

Every build, whatever server it opens, reads its updates from
`https://downloads.weldsuite.eu` (`latest.yml`, `latest-mac.yml`), and the
marketing site links the stable `download/WeldSuite-Setup.exe` and
`download/WeldSuite.dmg` there. The host is the EU cluster's route to the
Hetzner bucket `weldsuite-desktop-downloads`, which lives in a Hetzner project
of its own so its upload keys reach nothing else.

To release: bump `version` in `package.json`, merge, then run the
**Release Desktop** workflow (`.github/workflows/release-desktop.yml`) with
**publish** on. It builds macOS and Windows, uploads the versioned files, then
the manifests, then the `download/` aliases, and checks the public feed serves
the new version. Unchecked, it's a dry run whose files are attached to the run.

Builds before 0.3.0 opened Global and read `https://downloads.weldsuite.org`
(Cloudflare R2), which stays at 0.1.0.

## Microsoft Store

The Windows app is also in the Microsoft Store, which signs it, so it installs
without a SmartScreen warning (ADR FE-023). The installer on
downloads.weldsuite.eu stays unsigned.

- **Package**: an MSIX/AppX made by the `appx` target (`electron-builder.yml`).
  Microsoft signs it when it's submitted; the Store updates it, so a Store
  install (`process.windowsStore`) doesn't read the update feed, has no
  "Check for updates", and doesn't offer launch at login (Windows keeps an
  MSIX package's login item in its manifest; the platform hides the setting,
  from `getAppInfo().windowsStore`). The `weldsuite://` handler is in the
  manifest.
- **Identity**: Partner Center gives the app's package identity (the app's
  Product identity page: Package/Identity/Name, Package/Identity/Publisher,
  Package/Properties/PublisherDisplayName). Set them as the repository
  variables `WINDOWS_STORE_IDENTITY_NAME`, `WINDOWS_STORE_PUBLISHER` and
  `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME`; Release Desktop's Windows build then
  also makes the Store package, as the run's `microsoft-store` artifact.
- **Submitting**: in Partner Center, a new submission for the app, the two
  `.appx` (x64, arm64) under Packages, a listing in English and Dutch (the
  package declares both). The first one also asks why the app needs
  `runFullTrust` (it's a desktop app). Each submission needs a higher version
  than the last.
- **Locally**: `package:store` needs the identity on the command line and the
  Windows SDK's tools, because the `makeappx` in electron-builder's own tool
  bundles doesn't start on current Windows:

  ```powershell
  $env:ELECTRON_BUILDER_WINDOWS_KITS_PATH = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64'
  pnpm --filter desktop package:store -c.appx.identityName=<name> -c.appx.publisher=<CN=…> -c.appx.publisherDisplayName=<name>
  ```

  Windows installs an unsigned package only with Developer Mode on; Partner
  Center's own test flight is the other way to try one.
