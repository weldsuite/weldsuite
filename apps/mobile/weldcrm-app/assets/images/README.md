# WeldCRM image assets

| File | Spec | Purpose |
| --- | --- | --- |
| `icon.png` | 1024×1024 white tile | iOS / store launcher icon |
| `adaptive-icon.png` | 1024×1024 transparent FG | Android adaptive icon foreground (`backgroundColor` is white) |
| `splash-icon.png` | 1024×1024 transparent, ~50% fill | Native splash (light `#ffffff` / dark `#000000`) |
| `notification-icon.png` | 96×96 transparent | Android notification (tinted by plugin `color`) |
| `logo.png` | 512×512 transparent | Sign-in screen mark |

All five are generated from the platform's WeldCRM mark
(`apps/web/platform/public/assets/images/weldcrm/icon.svg`); see
`scripts/generate-icons.cjs` for how to run it.
