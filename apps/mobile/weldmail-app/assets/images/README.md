# WeldMail image assets

| File | Spec | Purpose |
| --- | --- | --- |
| `icon.png` | 1024×1024 white tile | iOS / store launcher icon |
| `adaptive-icon.png` | 1024×1024 transparent FG | Android adaptive icon foreground (`backgroundColor` is white) |
| `splash-icon.png` | 1024×1024 transparent, ~50% fill | Native splash (light `#ffffff` / dark `#000000`) |
| `notification-icon.png` | 96×96 transparent | Android notification (tinted by plugin `color`) |
| `logo.png` | landscape lockup | In-app branding (not regenerated here) |

Regenerate splash / adaptive / icon / notification from the platform SVG:

```bash
node scripts/generate-icons.cjs
```

The brand mark’s V is a transparent cutout, so one splash asset works in both light and dark mode (the splash `backgroundColor` shows through the V).
