import { CliError } from '../errors.js';
import {
  CREDENTIALS_VERSION,
  credentialsPath,
  writeCredentials,
  type StoredCredentials,
} from '../credentials.js';
import { defaultExternalApiUrl, resolveAppApiUrl, resolveLoginUrl } from '../env.js';
import { flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, dim, heading, info, success } from '../log.js';
import { openBrowser } from '../open-browser.js';

export const help = `${bold('weld login')} — sign in to WeldSuite for CLI commands

Opens the developer portal in your browser. Confirm the code, pick a workspace,
and the CLI stores a personal API key locally (no need to paste wsk_…).

Usage:
  ${cyan('weld login')} [--api-url <url>] [--login-url <url>] [--no-browser]

Options:
  --api-url <url>     external-api base (default: WELD_API_URL or production)
  --login-url <url>   developer portal origin (default: derived from api-url)
  --no-browser        print the URL only; do not spawn a browser

Environment:
  WELD_APP_API_URL    app-api host for the device-code endpoints
  WELD_LOGIN_URL      override developer portal origin
  WELD_API_URL        default external-api host written into credentials

CI / scripts: set ${cyan('WELD_API_KEY')} instead — it always overrides the login session.
`;

interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

type TokenPending = { status: 'pending'; interval?: number };
type TokenComplete = {
  status: 'complete';
  apiKey: string;
  keyId: string;
  keyPrefix: string;
  orgId: string;
  orgName: string | null;
  userId: string;
  email: string | null;
  apiUrl: string;
};

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(`Could not reach ${baseUrl} — ${detail}`);
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!response.ok) {
    const message =
      (json as { error?: { message?: string } } | undefined)?.error?.message ??
      `HTTP ${response.status}`;
    throw new CliError(message);
  }

  const envelope = json as { data?: T };
  if (envelope?.data === undefined) {
    throw new CliError('Unexpected response from login service.');
  }
  return envelope.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(args: ParsedArgs): Promise<void> {
  const apiUrl = trim(flagString(args.flags, 'api-url')) ?? defaultExternalApiUrl();
  const loginUrl = trim(flagString(args.flags, 'login-url')) ?? resolveLoginUrl(apiUrl);
  const appApiUrl = resolveAppApiUrl(apiUrl);
  const noBrowser = args.flags['no-browser'] !== undefined && args.flags['no-browser'] !== false;

  heading('WeldSuite CLI login');
  info(dim(`app-api: ${appApiUrl}`));
  info(dim(`external-api: ${apiUrl}`));

  const device = await postJson<DeviceStart>(appApiUrl, '/api/cli-auth/device', { loginUrl });

  info('');
  info(`Confirm this code in the browser: ${bold(device.userCode)}`);
  info('');
  info(`Opening ${cyan(device.verificationUriComplete)}`);
  if (noBrowser) {
    info('(browser launch skipped — open the URL above)');
  } else {
    openBrowser(device.verificationUriComplete);
  }
  info('');
  info(dim('Waiting for authorization…'));

  const deadline = Date.now() + device.expiresIn * 1000;
  let intervalMs = Math.max(1, device.interval) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const token = await postJson<TokenPending | TokenComplete>(appApiUrl, '/api/cli-auth/token', {
      deviceCode: device.deviceCode,
    });

    if (token.status === 'pending') {
      if (typeof token.interval === 'number' && token.interval > 0) {
        intervalMs = token.interval * 1000;
      }
      continue;
    }

    const stored: StoredCredentials = {
      version: CREDENTIALS_VERSION,
      apiKey: token.apiKey,
      keyId: token.keyId,
      keyPrefix: token.keyPrefix,
      apiUrl: token.apiUrl || apiUrl,
      orgId: token.orgId,
      orgName: token.orgName,
      userId: token.userId,
      email: token.email,
      createdAt: new Date().toISOString(),
    };
    writeCredentials(stored);

    success(`Logged in${token.email ? ` as ${token.email}` : ''}`);
    if (token.orgName) info(`Workspace: ${token.orgName}`);
    info(`Credentials saved to ${cyan(credentialsPath())} (mode 0600)`);
    info(`Key ${token.keyPrefix}… with scope user-apps:manage`);
    info('');
    info(`Try ${cyan('weld whoami')} or ${cyan('weld app list')}.`);
    return;
  }

  throw new CliError('Login timed out. Run weld login again.');
}

function trim(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\/+$/, '');
}
