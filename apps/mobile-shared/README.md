# Shared sources for the native apps

What `apps/ios` and `apps/android` are both built from:

| Path | What |
|---|---|
| `openapi/<module>.yaml` | The API contract per module, hand-written (OpenAPI 3.0). Both apps generate their clients from it at build time. |
| `strings/<source>/{en,nl}.json` | The apps' strings: `core` for the shared screens, one folder per app. Nested keys, `{name}` placeholders, `{ one, other }` plurals on `{count}`. |
| `tokens.json` | Design tokens: brand colours per app, status colours, radii, spacing. |

After changing anything here, run from the repo root:

```bash
pnpm mobile:generate
```

It writes the string catalogs and Swift accessors (iOS), `strings.xml`
(Android), `Tokens.swift` and `Tokens.kt`, and copies the OpenAPI files into
the Swift package targets. Commit what it writes; CI runs
`node scripts/mobile/generate.mjs --check` and fails when something is stale.

Every string needs `en` and `nl`; the generator refuses a key or a
placeholder that one locale lacks.
