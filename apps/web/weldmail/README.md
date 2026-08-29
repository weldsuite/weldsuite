# WeldMail Web

Consumer WeldMail SPA — claim a `@weldmail.com` address and use a personal inbox.

## Setup

```bash
pnpm install
pnpm --filter weldmail-web dev
```

Runs on [http://localhost:3200](http://localhost:3200).

## Environment

Copy `.env.example` or set:

| Variable | Description | Default |
| --- | --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (required) | — |
| `VITE_PERSONAL_API_URL` | personal-api base URL | `http://localhost:8787` (prod: `https://personal-api.weldsuite.org`) |

## Scripts

- `pnpm dev` — Vite dev server (port 3200)
- `pnpm build` — typecheck + production build
- `pnpm preview` — preview production build
