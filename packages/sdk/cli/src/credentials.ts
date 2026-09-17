/**
 * Local credential store for `weld login`.
 *
 * Path: `$XDG_CONFIG_HOME/weldsuite/credentials.json` (or `~/.config/weldsuite/`),
 * mode 0o600. `WELD_API_KEY` always wins when set (CI / scripts).
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.js';
import { bold, cyan } from './log.js';

export const CREDENTIALS_VERSION = 1 as const;

export interface StoredCredentials {
  version: typeof CREDENTIALS_VERSION;
  apiKey: string;
  keyId?: string;
  keyPrefix?: string;
  apiUrl: string;
  orgId?: string;
  orgName?: string | null;
  userId?: string;
  email?: string | null;
  createdAt: string;
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, 'weldsuite');
  return join(homedir(), '.config', 'weldsuite');
}

export function credentialsPath(): string {
  return join(configDir(), 'credentials.json');
}

export function readCredentials(path = credentialsPath()): StoredCredentials | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (parsed.version !== CREDENTIALS_VERSION || typeof parsed.apiKey !== 'string' || !parsed.apiKey) {
      return null;
    }
    if (typeof parsed.apiUrl !== 'string' || !parsed.apiUrl) return null;
    return parsed as StoredCredentials;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new CliError(`Could not read credentials at ${path}: ${(err as Error).message}`);
  }
}

export function writeCredentials(creds: StoredCredentials, path = credentialsPath()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on platforms that ignore mode.
  }

  const tmp = `${path}.${process.pid}.tmp`;
  const body = `${JSON.stringify(creds, null, 2)}\n`;
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // ignore
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }
}

export function clearCredentials(path = credentialsPath()): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw new CliError(`Could not remove credentials at ${path}: ${(err as Error).message}`);
  }
}

export function missingAuthMessage(): string {
  return [
    `${bold('Not logged in.')}`,
    '',
    `Run ${cyan('weld login')} to sign in with your WeldSuite account (opens a browser),`,
    'or set a workspace API key for CI / scripts:',
    '',
    `  ${cyan('export WELD_API_KEY=wsk_...')}`,
    '',
    'Create a key under Settings → API keys with scope user-apps:manage.',
  ].join('\n');
}
