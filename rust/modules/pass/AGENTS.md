# WeldPass (`rust/modules/pass`)

WeldPass is a platform module with two surfaces: **secret vaults** for apps
(env vars, pushed to Cloudflare Workers, Cloudflare Pages and Vercel) and a
**password manager** for people (logins, secure notes, cards). Read the root
`AGENTS.md` and `rust/AGENTS.md` first; this file adds what is specific to
WeldPass.

## Where things are

- Routes: `src/lib.rs` mounts `/api/weldpass`: `routes_projects.rs` (vaults
  and secrets), `routes_passwords.rs` (`/api/weldpass/{vaults,items,password-health,teammates}`),
  `routes_devices.rs` (a phone's encrypted offline copy, ADR PASS-010).
- Schema: the `weldpass_*` entities in `rust/crates/schema/src/tenant/`
  (tenant DB only).
- Client and shared Zod schemas: `@weldsuite/app-api-client`
  (`schemas/weldpass`, `schemas/weldpass-passwords` with the strength, generator
  and host-matching helpers; `domains/weldpass`, `domains/weldpass-passwords`).
- Platform UI: `apps/web/platform/app/weldpass/`, hooks
  `hooks/queries/use-weldpass-queries.ts` and
  `use-weldpass-passwords-queries.ts`.
- Browser extension: `apps/web/weldpass-extension` (MV3, Chrome/Edge). It
  reuses the web app's session, has no always-on content script, and touches a
  page only on a click in its popup. Not deployed by CI.
- Mobile apps: the native apps in `apps/ios` and `apps/android` call these
  routes through the contract in `apps/mobile-shared/openapi/weldpass.yaml`
  (`tests/openapi_contract.rs` checks the answers against it). A change to an
  answer they read, above all a new item type, vault kind or role, follows
  "Changing the contract" in `apps/mobile-shared/README.md`: apps already on
  phones can't read an enum value they don't know.

## Encryption

Envelope encryption (`src/envelope.rs`): the root key `WELDPASS_ROOT_KEY`
wraps a per-project KEK (`weldpass_projects.kek_wrapped`), which wraps a
per-write data key, which encrypts the value. Ciphertexts are AAD-bound to
their project, environment and key, so a row copied elsewhere fails to decrypt
instead of yielding the wrong value.

- **Losing `WELDPASS_ROOT_KEY` makes every stored secret unrecoverable.** It
  is not `DATABASE_ENCRYPTION_KEY`, which only protects stored tenant DB URLs
  and integration tokens. Rotating it rewrites only the project rows
  (`rewrap_vault_key`, `src/rotation.rs`), never the secrets.
- Password items are sealed whole (`seal_item`, bound to vault + item). The
  plain columns on `weldpass_items` (title, subtitle, url, host) are derived on
  each write for listing and extension matching.
- **Never store a checksum, hash or hint of a password**: an unsalted hash of
  a human-chosen password is most of the way to the password. Password health
  (weak, reused, old) is computed in memory on demand (`src/health.rs`).
- 2FA codes are minted on the server (`src/totp.rs`), so a teammate gets the
  six digits without the seed.

## Access

- **Secret vaults** use workspace permissions: `secrets:read` lists keys and
  metadata, `secrets:reveal` decrypts, kept apart on purpose; also
  `secrets:create|update|delete|sync|manage`. OWNER and ADMIN have all of
  them; MEMBER and VIEWER none until granted.
- **The password manager goes by vault membership.** Everyone gets a personal
  vault (created on first use, owner-only). Shared vaults have members with a
  role: `viewer` (list and reveal), `editor` (also write, move, delete items),
  `manager` (also members, rename, delete, activity). Every route resolves this
  through `require_vault_access` (`src/password_vaults.rs`); a vault the caller
  can't see is a 404.
- Workspace permissions only open the door: `passwords:use` (MEMBER and up),
  `passwords:create` (start a shared vault), `passwords:manage` (ADMIN: see
  every shared vault and fix its membership). `passwords:manage` never opens a
  personal vault, and reading a shared vault's items still means joining it,
  which is recorded.
- Sharing is moving an item into a shared vault (`POST …/items/:id/move`): it
  is re-sealed under the target vault's key as a new item, and its history
  stays behind.

## No entity events

WeldPass publishes **no** entity events: the bus feeds workflows, analytics and
AI agents, and neither secret metadata nor credential names belong there. It
writes its own trail instead: `weldpass_audit_events` for vaults and secrets,
`weldpass_vault_events` for the password manager, reveals and 2FA codes
included.

## Outside providers

The push targets (Cloudflare Workers and Pages, Vercel) are called over their
REST APIs in `src/providers.rs` and `src/sync.rs`.
