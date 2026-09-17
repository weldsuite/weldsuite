import { loadConfig, listApps } from '../api.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, info, renderTable, success } from '../log.js';
import { credentialsPath, readCredentials } from '../credentials.js';
import { flagBool, type ParsedArgs } from '../args.js';

export const help = `${bold('weld whoami')} — show the active CLI identity

Prints the local login session (or WELD_API_KEY override). Pass --check to
ping the API with a lightweight list call.

Usage:
  ${cyan('weld whoami')} [--check]
`;

export async function run(args: ParsedArgs): Promise<void> {
  const check = flagBool(args.flags, 'check');
  const envKey = process.env.WELD_API_KEY;
  const stored = readCredentials();

  if (envKey) {
    info(`${bold('Auth')}: environment ${cyan('WELD_API_KEY')} (overrides local login)`);
    info(`${bold('Key')}: ${maskKey(envKey)}`);
  } else if (stored) {
    info(`${bold('Auth')}: local credentials (${cyan(credentialsPath())})`);
    if (stored.email) info(`${bold('User')}: ${stored.email}`);
    if (stored.userId) info(`${bold('User id')}: ${dim(stored.userId)}`);
    if (stored.orgName || stored.orgId) {
      info(`${bold('Workspace')}: ${stored.orgName ?? stored.orgId}`);
    }
    if (stored.keyPrefix) info(`${bold('Key')}: ${stored.keyPrefix}…`);
    info(`${bold('API')}: ${stored.apiUrl}`);
    if (stored.createdAt) info(`${bold('Logged in')}: ${stored.createdAt}`);
  } else {
    throw new CliError(
      `Not logged in. Run ${cyan('weld login')} or set ${cyan('WELD_API_KEY')}.`,
    );
  }

  if (!check) return;

  const config = loadConfig();
  const apps = await listApps(config);
  success(`API ok — ${apps.length} app(s) visible`);
  if (apps.length > 0) {
    info(
      renderTable(
        ['code', 'name'],
        apps.slice(0, 5).map((app) => [app.code, app.name]),
      ),
    );
  }
}

function maskKey(key: string): string {
  if (key.length <= 12) return 'wsk_…';
  return `${key.slice(0, 8)}…`;
}
