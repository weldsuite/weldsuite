# WeldCalendar

Team and personal calendar for WeldSuite — agenda, month view, calendars, and events.

## Stages (EAS profiles)

| Profile | Purpose | APIs |
|---|---|---|
| `development` | Dev client (`expo-dev-client`), internal | test |
| `preview` | Internal QA binary | test |
| `production` | Store / prod binary (`autoIncrement`) | prod |

## Local development

```bash
pnpm --filter weldcalendar-app start          # Metro against an installed dev client
eas build --profile development --platform android
```

Copy `.env.example` → `.env` if needed. EAS builds inject env from `eas.json`.

## Production checklist

See [`store/README.md`](./store/README.md) for Firebase, Clerk native apps, App Store / Play, and submit steps.

## CI

- Native builds: `.github/workflows/mobile-build.yml` (tick **WeldCalendar**)
- OTA updates: `.github/workflows/deploy.yml` job `mobile-weldcalendar`
