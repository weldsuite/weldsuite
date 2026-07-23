# Runtime resources

Files here are copied into the packaged app and resolvable via
`process.resourcesPath`.

Required before packaging:

- `trayTemplate.png`, tray icon. macOS expects a template image (black + alpha).
  Recommended: 16×16 and 32×32 (`trayTemplate@2x.png`).
