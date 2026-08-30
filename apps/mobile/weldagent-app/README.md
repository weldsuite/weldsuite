# WeldAgent (Expo)

Mobile companion for WeldSuite AI agents: chat, workspace agents, credits, and push when a reply or run is ready.

- Bundle: `com.weldsuite.weldagent`
- Scheme: `weldagent`
- Brand: `#8d65ef`

## Local

```bash
pnpm --filter weldagent-app start
pnpm --filter weldagent-app test
pnpm --filter weldagent-app generate:assets
```

Requires `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` and `EXPO_PUBLIC_APP_API_URL` (see `.env.example`).

## Production wiring still needed (human)

`eas init` under Expo org `weldsuite`, Apple/Play credentials, and Firebase files for this package. Do not copy another app's `google-services.json`. See `store/README.md`.

Until `eas init` runs, `app.config.js` warns locally and throws on CI/EAS if the project id is still the placeholder.
