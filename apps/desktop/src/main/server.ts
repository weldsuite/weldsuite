import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { isLoopbackHostname, issuerFromRuntimeConfig } from './loopback-sign-in';

/**
 * Which WeldSuite server the shell loads (README.md, "Servers").
 *
 * WeldSuite EU by default. A person can pick another server, a self-hosted
 * install or a test cluster, from "Change server…"; the choice is kept in
 * `server.json` next to `settings.json`, outside the settings the app's page
 * can write (`weldsuite:settings:set`), so no page can move the shell to
 * another server. `DESKTOP_APP_URL` wins over both, for development.
 *
 * Global (app.weldsuite.org) isn't offered: it is being retired (ADR OPS-025),
 * and its app serves no `/config.json`, so the check below refuses it.
 */

/** WeldSuite EU, the hosted edition. */
export const DEFAULT_SERVER = 'https://app.weldsuite.eu';

/** The platform's dev server, when the shell runs from `pnpm --filter desktop dev`. */
export const DEVELOPMENT_SERVER = 'http://localhost:3000';

/** How long a server gets to answer `/config.json` before it counts as unreachable. */
export const CHECK_TIMEOUT_MS = 10_000;

/**
 * The origin of an address someone typed: `weldsuite.example.com`,
 * `https://weldsuite.example.com/whatever`. https only, or http on a loopback
 * host for development; no user name or password. Null for anything else.
 */
export function normaliseServerAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const transport = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
  if (!transport || !url.hostname) return null;
  return url.origin;
}

/** What a server answered to `/config.json`. */
export type ServerCheck =
  /** A WeldSuite server with OIDC sign-in. `browserSignIn`: it names the desktop client, so sign-in goes through the system browser. */
  | { status: 'ok'; origin: string; edition: string | null; browserSignIn: boolean }
  /** Not an address the shell accepts (normaliseServerAddress). */
  | { status: 'invalid' }
  /** No answer, a network error, or a status other than 200. */
  | { status: 'unreachable'; origin: string }
  /** It answered, but not as a WeldSuite server the shell can sign in to. */
  | { status: 'not_weldsuite'; origin: string };

/**
 * What `/config.json` says about a server: a WeldSuite server with an OIDC
 * issuer (EU, self-hosted), or not (Global, or not WeldSuite at all).
 */
export function describeRuntimeConfig(
  origin: string,
  config: unknown,
): Extract<ServerCheck, { status: 'ok' | 'not_weldsuite' }> {
  if (!issuerFromRuntimeConfig(config)) return { status: 'not_weldsuite', origin };
  const record = config as { edition?: unknown; auth?: { desktopClientId?: unknown } };
  const desktopClientId = record.auth?.desktopClientId;
  return {
    status: 'ok',
    origin,
    edition: typeof record.edition === 'string' ? record.edition : null,
    browserSignIn: typeof desktopClientId === 'string' && desktopClientId.length > 0,
  };
}

/** The part of `fetch` the check needs: Electron's `net.fetch` in the app, a stub in tests. */
export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'error' }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Ask an address for its `/config.json`. No redirects: a server that answers
 * from somewhere else is not the one that was typed.
 */
export async function checkServer(input: unknown, fetchImpl: FetchLike, timeoutMs = CHECK_TIMEOUT_MS): Promise<ServerCheck> {
  const origin = normaliseServerAddress(input);
  if (!origin) return { status: 'invalid' };
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${origin}/config.json`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch {
    return { status: 'unreachable', origin };
  }
  if (response.status !== 200) return { status: 'unreachable', origin };
  let config: unknown;
  try {
    config = await response.json();
  } catch {
    // Global's app answers /config.json with its index.html.
    return { status: 'not_weldsuite', origin };
  }
  return describeRuntimeConfig(origin, config);
}

/** The server the shell loads, and why. */
export interface ServerChoice {
  url: string;
  /** `DESKTOP_APP_URL` chose it; "Change server…" can't. */
  fromEnvironment: boolean;
}

/**
 * The server to load: `DESKTOP_APP_URL`, else the one picked in
 * "Change server…", else the platform's dev server in development, else
 * WeldSuite EU. An environment value is taken as it is (any origin, for
 * development); a stored one only if it still passes normaliseServerAddress.
 */
export function resolveServer(opts: { environment?: string; stored: string | null; development: boolean }): ServerChoice {
  const fromEnvironment = opts.environment?.trim();
  if (fromEnvironment) return { url: fromEnvironment, fromEnvironment: true };
  const stored = normaliseServerAddress(opts.stored);
  if (stored) return { url: stored, fromEnvironment: false };
  return { url: opts.development ? DEVELOPMENT_SERVER : DEFAULT_SERVER, fromEnvironment: false };
}

/** `server.json` in the user data folder. */
export function serverFilePath(userData: string): string {
  return path.join(userData, 'server.json');
}

/** The stored server, or null for none (or an unreadable file). Synchronous: read before the window opens. */
export function readStoredServer(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { url?: unknown };
    return normaliseServerAddress(parsed?.url);
  } catch {
    return null;
  }
}

/** Keep a server, or forget it (null: back to the default). */
export async function writeStoredServer(file: string, url: string | null): Promise<void> {
  if (url === null) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ url }, null, 2), 'utf-8');
}

/** The host to show for a server: `app.weldsuite.eu`. */
export function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
