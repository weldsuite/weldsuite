# desktop

Electron shell around the platform SPA. One codebase: the desktop app loads the
live platform web app and layers native integrations on top (screen share, tray,
OS notifications, deep links, auto-update, badge count).

## Stack

- Electron 33 + electron-vite (dev loop) + electron-builder (packaging)
- Ships Chromium → identical `getDisplayMedia` behavior across OS
- Auto-update via `electron-updater` (generic provider, configurable in
  `electron-builder.yml`)
- Deep-link scheme: `weldsuite://…`

## Dev

```bash
# Start platform (port 3000) in another shell:
pnpm --filter @weldsuite/platform dev

# Start desktop shell pointing at localhost:3000
pnpm --filter desktop dev
```

Override the target URL with `DESKTOP_APP_URL`:

```bash
DESKTOP_APP_URL=https://staging.weldsuite.com pnpm --filter desktop dev
```

## Package

```bash
pnpm --filter desktop package:win     # NSIS installer (x64 + arm64)
pnpm --filter desktop package:mac     # DMG (x64 + arm64)
pnpm --filter desktop package:linux   # AppImage + deb
```

Artifacts land in `release/`.

## Icons

Drop these before packaging:

- `assets/icon.ico` (Windows, 256×256 multi-size)
- `assets/icon.icns` (macOS)
- `assets/icon.png` (Linux, 512×512)
- `resources/trayTemplate.png` (tray; macOS expects a template image, black
  with alpha, `@2x` variant recommended)

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

## Auto-update

Publishes to `https://updates.weldsuite.com/desktop` (generic provider). Swap
for S3/GitHub/Azure in `electron-builder.yml` when infra is ready.
