# WeldAgent cloud computer (Cloudflare Sandbox + Browser Run)

Internal Worker called by `app-api` with `Authorization: Bearer <INTERNAL_API_SECRET>`.

## Local

1. Docker Desktop running (`docker info` succeeds)
2. `pnpm install` from repo root
3. `wrangler secret put INTERNAL_API_SECRET` (same value as app-api)
4. `pnpm dev` → http://localhost:8795
5. Point app-api `AGENT_RUNTIME_URL=http://localhost:8795`

## API

All under `/v1/*` (auth required):

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/computer/status?workspaceId=` | Sandbox id / enabled |
| POST | `/v1/computer/exec` | Shell command |
| POST | `/v1/computer/files/read\|write\|list` | Files under `/workspace` |
| POST | `/v1/computer/code` | Python / JS |
| POST | `/v1/computer/destroy` | Tear down sandbox |
| POST | `/v1/browser/open` | Open URL + extract |
| POST | `/v1/browser/act` | Click / type / screenshot / live_view |
| POST | `/v1/browser/close` | End browser session |

## Deploy notes

- First deploy provisions the container image (several minutes).
- Create a real KV namespace for `BROWSER_SESSIONS` and replace the placeholder id in `wrangler.toml`.
- Align `Dockerfile` base tag with `@cloudflare/sandbox` version.
