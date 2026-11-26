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

## Changing the contract

Apps already on phones keep reading the server's answers with the contract
they were built with:

- A new field in a response is safe. Don't mark a response object
  `additionalProperties: false`: the Swift client then throws on any key it
  doesn't know.
- A new value in a response enum is not. Both clients throw on a value they
  don't know, and the whole response fails (Android reads it as null only
  where the field is nullable). Ship the apps that know the value first, then
  raise `mobile.minVersions` in `/config.json` before the server sends it.
- A field that becomes optional, or a type that changes, breaks both.
