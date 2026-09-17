import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  clearCredentials,
  CREDENTIALS_VERSION,
  readCredentials,
  writeCredentials,
} from './credentials.js';
import { loadConfig } from './api.js';
import { CliError } from './errors.js';
import { resolveAppApiUrl, resolveLoginUrl } from './env.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.WELD_API_KEY;
  delete process.env.WELD_API_URL;
  delete process.env.WELD_APP_API_URL;
  delete process.env.WELD_LOGIN_URL;
  delete process.env.XDG_CONFIG_HOME;
});

function tempCredPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'weld-cli-'));
  dirs.push(root);
  process.env.XDG_CONFIG_HOME = root;
  return join(root, 'weldsuite', 'credentials.json');
}

describe('credentials store', () => {
  it('writes mode 0600 and round-trips', () => {
    const path = tempCredPath();
    writeCredentials({
      version: CREDENTIALS_VERSION,
      apiKey: 'wsk_testkey',
      apiUrl: 'https://api.weldsuite.org',
      email: 'dev@example.com',
      createdAt: new Date().toISOString(),
    });
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { apiKey: string };
    assert.equal(raw.apiKey, 'wsk_testkey');
    const stored = readCredentials();
    assert.ok(stored);
    assert.equal(stored.email, 'dev@example.com');
    assert.equal(clearCredentials(), true);
    assert.equal(readCredentials(), null);
  });
});

describe('loadConfig precedence', () => {
  it('prefers WELD_API_KEY over the credentials file', () => {
    tempCredPath();
    writeCredentials({
      version: CREDENTIALS_VERSION,
      apiKey: 'wsk_from_file',
      apiUrl: 'https://api.weldsuite.org',
      createdAt: new Date().toISOString(),
    });
    process.env.WELD_API_KEY = 'wsk_from_env';
    const config = loadConfig();
    assert.equal(config.apiKey, 'wsk_from_env');
    assert.equal(config.fromEnv, true);
  });

  it('falls back to credentials when env is unset', () => {
    tempCredPath();
    writeCredentials({
      version: CREDENTIALS_VERSION,
      apiKey: 'wsk_from_file',
      apiUrl: 'https://api-test.weldsuite.org',
      createdAt: new Date().toISOString(),
    });
    const config = loadConfig();
    assert.equal(config.apiKey, 'wsk_from_file');
    assert.equal(config.apiUrl, 'https://api-test.weldsuite.org');
    assert.equal(config.fromEnv, false);
  });

  it('throws a friendly error when nothing is configured', () => {
    tempCredPath();
    assert.throws(() => loadConfig(), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match((err as CliError).message, /weld login/);
      return true;
    });
  });
});

describe('env helpers', () => {
  it('derives test hosts from WELD_API_URL', () => {
    process.env.WELD_API_URL = 'https://api-test.weldsuite.org';
    assert.equal(resolveAppApiUrl(), 'https://app-api-test.weldsuite.org');
    assert.equal(resolveLoginUrl(), 'https://developer-test.weldsuite.org');
  });
});
