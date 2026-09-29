# WeldAgent cloud computer (Cloudflare Sandbox + Browser Run)

Internal Worker called by `agent-api` and `chat-api`. They reach it through the
`AgentRuntimeInternal` entrypoint (service binding `AGENT_RUNTIME`, no secret) and
fall back to the public URL with `Authorization: Bearer <INTERNAL_API_SECRET>`
while the binding is absent. Deploy agent-runtime before adding the binding to a
caller.

## Local

1. Docker Desktop running (`docker info` succeeds)
2. `pnpm install` from repo root
3. `wrangler secret put INTERNAL_API_SECRET` (same value as agent-api / chat-api)
4. `pnpm dev` → http://localhost:8795
5. Point agent-api `AGENT_RUNTIME_URL=http://localhost:8795` (local dev uses the URL path)

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
- `BROWSER_SESSIONS` KV is provisioned (dev / test / production) in `wrangler.toml`.
- Align `Dockerfile` base tag with `@cloudflare/sandbox` version.
- Set `INTERNAL_API_SECRET` with `wrangler secret put INTERNAL_API_SECRET --env test` (and production) so it matches agent-api / chat-api (fallback path only).
