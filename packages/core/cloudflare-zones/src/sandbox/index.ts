/**
 * WeldHost DNS sandbox: customer DNS zones on the test environment live in a
 * D1-backed stand-in for Cloudflare instead of the real account, so a domain
 * registered at Realtime Register's OTE gets a zone and editable records
 * without anything reaching real DNS. Plan: docs/plans/weldhost-test-environment.md.
 *
 * Turned on per worker by calling {@link configureZonesSandbox} with the
 * worker's env at the top of every handler. It does nothing unless
 * `WELDHOST_DNS_MODE` is `sandbox`, and refuses to run in production.
 */

import { setZonesTransport } from '../transport';
import { createSandboxZonesFetch } from './fetch';
import { d1SandboxStore, type D1Like } from './store';

export {
  createSandboxZonesFetch,
  isSandboxZoneId,
  SANDBOX_ZONE_ID_PREFIX,
  DEFAULT_SANDBOX_NAMESERVERS,
  DEFAULT_ACTIVATE_AFTER_MS,
  type SandboxFetchOptions,
} from './fetch';
export {
  memorySandboxStore,
  d1SandboxStore,
  type SandboxStore,
  type SandboxZone,
  type SandboxRecord,
  type D1Like,
} from './store';

export interface ZonesSandboxEnv {
  ENVIRONMENT?: string;
  /** `sandbox` turns the DNS sandbox on. Anything else leaves real Cloudflare in place. */
  WELDHOST_DNS_MODE?: string;
  /** Test-only D1 database holding the sandbox zones and records. */
  DNS_SANDBOX?: D1Like;
  /** Comma-separated nameservers handed out for sandbox zones. */
  DNS_SANDBOX_NAMESERVERS?: string;
}

export function isZonesSandboxEnabled(env: ZonesSandboxEnv): boolean {
  return env.WELDHOST_DNS_MODE?.trim().toLowerCase() === 'sandbox';
}

/** Configured nameservers, or an empty list when none are set. */
export function sandboxNameserversFromEnv(env: ZonesSandboxEnv): string[] {
  return (env.DNS_SANDBOX_NAMESERVERS ?? '')
    .split(',')
    .map((ns) => ns.trim().toLowerCase())
    .filter(Boolean);
}

let configuredFor: D1Like | undefined;

/**
 * Point the zones client at the sandbox when this env asks for it. A no-op
 * otherwise, so it never undoes a transport a test installed.
 *
 * Throws rather than falling back to real Cloudflare when the sandbox is
 * requested but cannot run: in production, or without the D1 binding.
 */
export function configureZonesSandbox(env: ZonesSandboxEnv): void {
  if (!isZonesSandboxEnabled(env)) return;
  if (env.ENVIRONMENT === 'production') {
    throw new Error('WELDHOST_DNS_MODE=sandbox is not allowed in production');
  }
  if (!env.DNS_SANDBOX) {
    throw new Error('WELDHOST_DNS_MODE=sandbox needs the DNS_SANDBOX D1 binding');
  }
  if (configuredFor === env.DNS_SANDBOX) return;
  const realFetch = globalThis.fetch.bind(globalThis);
  setZonesTransport(
    createSandboxZonesFetch({
      store: d1SandboxStore(env.DNS_SANDBOX),
      passthrough: (input, init) => realFetch(input as RequestInfo, init as RequestInit),
      nameservers: sandboxNameserversFromEnv(env),
    }),
  );
  configuredFor = env.DNS_SANDBOX;
}
