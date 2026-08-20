# WeldStash image assets

| File | Spec | Purpose |
| --- | --- | --- |
| `icon.png` | 1024×1024 white tile | iOS / store launcher icon |
| `adaptive-icon.png` | 1024×1024 transparent FG | Android adaptive icon foreground (`backgroundColor` is white) |
| `splash-icon.png` | 1024×1024 transparent, ~50% fill | Native splash (light `#ffffff` / dark `#000000`) |
| `notification-icon.png` | 96×96 transparent | Android notification (tinted by plugin `color`) |
| `logo.png` | 1024×1024 transparent | Login screen |

Source mark: `apps/web/platform/public/assets/images/weldstash/icon.svg` (same warehouse used by the WeldStash platform module).

```bash
node scripts/generate-icons.cjs
```
