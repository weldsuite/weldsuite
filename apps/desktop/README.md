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
  const sources = await window.weldsuiteDesktop.getDesktopSources();
  // render your own source picker, then call getUserMedia with the chosen id
}
```

Typings live at `apps/web/platform/types/weldsuite-desktop.d.ts`.

## Screen sharing (WeldMeet)

Flow:

1. User clicks "Share screen" in WeldMeet
2. Platform calls `window.weldsuiteDesktop.getDesktopSources()`
3. Platform renders a source-picker modal (screens + app windows with thumbnails)
4. Platform calls `navigator.mediaDevices.getUserMedia` with the chosen source:

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: false,
  video: {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: source.id,
      maxWidth: 1920,
      maxHeight: 1080,
    },
  } as any,
});
```

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
