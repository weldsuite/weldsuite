# WeldAgent (Expo)

Mobile companion for WeldSuite AI agents: chat, workspace agents, credits, and push when a reply or run is ready.

- Bundle: `com.weldsuite.weldagent`
- Scheme: `weldagent`
- Brand: `#8d65ef`
- EAS project: `cc1b21b9-17f3-490b-8088-3c62761d1d00`

## Local

```bash
cp .env.example .env
pnpm --filter weldagent-app start
pnpm --filter weldagent-app test
pnpm --filter weldagent-app generate:assets
```

## Push notifications

In-repo wiring is done (project id, channel `weldagent`, deep links, OTA env).
You still need Firebase app configs + EAS FCM/APNs credentials for this package.

See **[store/README.md](./store/README.md)** for the exact Firebase + `eas credentials` steps.
