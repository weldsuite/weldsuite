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

## The server is tested against the contract

Rust tests send every operation in `openapi/` through the server's router
and hold each answer against the file, as strictly as the generated clients
decode it: the success status (201 is not 200 to the Swift client), the
`{ data }` envelope, every `required` property, `null` only where the file
says `nullable`, the types, and enum values within the enum. A property the
file doesn't list is fine. An error must decode as the file's
`ErrorResponse`, a validation failure included.

| File | Tested in |
|---|---|
| `openapi/weldpass.yaml` | `rust/modules/pass/tests/openapi_contract.rs` |
| `openapi/core.yaml` | `getRuntimeConfig`: `rust/bins/weldsuite/src/server.rs`; `listWorkspaces`: `rust/modules/core-team/tests/openapi_contract.rs` |

The checker is `weldsuite_kit::openapi_contract` (feature
`openapi-contract`). It reads the YAML itself, a subset of YAML and of
OpenAPI 3.0, and refuses anything else (anchors, folded text, `oneOf`, an
unknown `format`) rather than skip it: extend it before using those. Its
`CHECKED_IN` list names where each file is tested, and its own tests fail
when a file here isn't listed or an operation isn't named in one of its test
files, so a new operation needs a test that sends it.

CI's Rust job runs them, and a change under `openapi/` starts it. The
WeldPass and workspace tests need the test databases
(`WELDSUITE_TEST_TENANT_URL`, `WELDSUITE_TEST_MASTER_URL`, see
`rust/README.md`) and skip without them. From `rust/`:

```bash
cargo test -p weldsuite-kit --features openapi-contract openapi_contract
cargo test -p weldsuite-pass --test openapi_contract
cargo test -p weldsuite-core-team --test openapi_contract
```

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
  The apps already obey `mobile.minVersions`; the Rust server doesn't send
  it yet, so that has to be built before the first such change.
- A field that becomes optional, or a type that changes, breaks both.
