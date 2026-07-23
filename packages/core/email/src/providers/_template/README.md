# Provider template

Scaffold for adding a new email provider to `@weldsuite/email`.

## How to add a provider

1. **Copy the folder.**
   `cp -r packages/email/src/providers/_template packages/email/src/providers/<name>`

2. **Implement the interfaces you need.** A provider can implement any subset
   of `IEmailSendProvider`, `IEmailReceiveProvider`, `IMailDomainProvider`,
   `IMailAccountProvider` (from `@weldsuite/email/core/types`). Don't stub out
   what you don't support, the registry will report the missing capability.

3. **Wire registration.** Edit `index.ts` so every consuming worker can call
   `register<Name>Send`/`Receive`/`Domain` from its bootstrap.

4. **Expose the subpath in `packages/email/package.json`.** Add
   `"./providers/<name>": "./src/providers/<name>/index.ts"` under `exports`.

5. **(Optional) Extend `mailProviderEnum` in
   `packages/db/src/schema/mail-accounts.ts`** if you want users to be able to
   pick this provider on a per-account basis. **Do NOT generate the migration
   yourself**, flag the schema diff with the user (per repo CLAUDE.md).

## File layout

| File           | Purpose                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| `types.ts`     | Provider-specific config + binding types.                                        |
| `send.ts`      | `IEmailSendProvider` impl. Throw `PendingVerificationError` when applicable.     |
| `receive.ts`   | `IEmailReceiveProvider` impl. Use `parseRawEmail` from `@weldsuite/email/core`.  |
| `domain.ts`    | `IMailDomainProvider` impl, provision, deprovision, DNS record lookup.          |
| `index.ts`     | `register<Name>Send/Receive/Domain` helpers + re-exports.                        |

## Conventions

- Constructor injection only: providers never read `process.env` or
  `globalThis`, every dependency is passed in via the `register*` call. This
  keeps the same provider class usable from a Worker, from a Trigger.dev
  task, and from a unit test.
- Throw the typed errors from `@weldsuite/email/core/errors` so the call
  site can pattern-match (`PendingVerificationError`,
  `TransientProviderError`, `PermanentProviderError`, `ProviderConfigError`).
- Don't import the runtime modules of the host environment (e.g.
  `cloudflare:email`) at the top of the file, accept the runtime class as a
  constructor option so the package stays portable.
