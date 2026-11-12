# forms-portal: WeldForms respondent page

Where people fill in a form (`forms.weldsuite.org/f/<publicId>`,
`forms-test.weldsuite.org/f/<publicId>`), and the page the embed SDK frames.
TanStack Start on a Cloudflare Worker (FE-015), plus a Node build for the
Kubernetes editions (FE-017). Tailwind v4 and `@weldsuite/ui` for the chrome;
the form itself is `@weldsuite/forms-renderer`. No Clerk, no database, no
tenant secrets (ADR FORMS-002). Plan: `docs/plans/weldforms.md`.

## Routes

| Route | |
|---|---|
| `/f/<publicId>` | the form, server rendered with its theme, Open Graph / Twitter tags, `frame-ancestors` from the form's allowed embed domains |
| `/f/<publicId>?embed=<mode>` | the embed view (`inline`, `popup`, `slider`, `popover`, `fullpage`): only the password line as footer, postMessage to the host page |
| `/f/<publicId>?<name>=<value>` | values for the hidden fields the form declares (others are dropped); `utm_*` and `?source=qr` are recorded |
| `/i/<publicId>.<token>` | a personal invitation link (`/f/<publicId>?invitation=<token>` is the same) |
| `/embed.js` | the embed SDK, bundled from `packages/sdk/forms-embed` by `vite-plugins/forms-embed.ts` |
| `/api/*` | what the page's JavaScript calls; forwarded to forms-api `/public/forms/*` with the key, IP, country and browser (`lib/server/proxy.ts`, an allowlist of routes) |

## How it talks to forms-api

Server side only. Every call carries `X-Forms-Portal-Key`
(`FORMS_PORTAL_SECRET`), `X-Respondent-Ip` (`CF-Connecting-IP` on Workers;
`X-Forwarded-For` counted from the right by `FORMS_PORTAL_TRUSTED_PROXIES` on
Node), `X-Respondent-Country` (`CF-IPCountry`) and the user agent. Session routes
take the respondent's session as `Authorization: Bearer`; the browser keeps it in
memory and `localStorage` per form (no cookies: embeds). Deployed, calls go over
the `FORMS_API` service binding; locally to `FORMS_API_URL`
(`http://localhost:8828`, `pnpm --filter forms-api dev`). The published form is
cached in memory for 60 seconds.

## The respondent flow

- The first paint is the form. An anonymous form starts its session lazily (first
  progress, upload or submit), so visitors who only look cost nothing. A saved
  session (7 days) resumes when the form keeps partial responses, allows edits or
  limits one response per person; invitations and verified emails start theirs at once.
- Bot check: Turnstile (`interaction-only`) on Global, ALTCHA proof of work (solved
  in the browser against `GET /public/forms/altcha/challenge`) on Kubernetes.
  Tokens are single use: `lib/client/bot-check.ts`.
- Progress is saved debounced; the honeypot field `website` goes with the submit.
- Footer: "Never submit passwords through WeldForms", Report abuse, and the badge
  when the plan shows it.

## Embed protocol

`packages/sdk/forms-embed/src/protocol.ts` (shared types). The portal posts
`ready`, `height`, `submitted` (with the response id), `redirect` and `close`
(Escape in popup, slider and popover) to the parent window; the SDK checks origin
and window before acting. Change the SDK and the portal together.

## Texts

`packages/core/i18n/src/locales/{en,nl}/forms-portal.ts`: the page's own texts
and `renderer`, the renderer's labels. Language: the form's `presentation.language`,
then the `locale` cookie, then Accept-Language.

## Running and deploying

```bash
pnpm --filter forms-api dev            # http://localhost:8828
pnpm --filter forms-portal dev         # http://localhost:3025/f/<publicId>
pnpm --filter forms-portal build       # Worker (CLOUDFLARE_ENV=test|production picks the environment)
pnpm --filter forms-portal build:node  # Node server, `node node/server.mjs` (image target forms-portal)
```

Workers `weldsuite-forms-portal-test` and `weldsuite-forms-portal` (custom domains
in `wrangler.toml`), released by `deploy.yml` (`start-workers`). Secret:
`FORMS_PORTAL_SECRET` (same value as forms-api). Kubernetes: Helm `formsPortal`,
`FORMS_PORTAL_BACKEND_URL`, `config.forms.portalUrl`.
