import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { apiRequest, CliError, loadConfig, resolveAppId } from '../api.js';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, info, success, warn } from '../log.js';
import { loadManifest } from '../manifest.js';

export const help = `${bold('weld app delete')} — soft-delete an app

Deletes the app owned by your workspace (DELETE /v1/user-apps/:id).
Refused while other workspaces still have it installed.

Options:
  --code <code>     App code (default: weldapp.json)
  --yes             Skip the confirmation prompt

Requires WELD_API_KEY.
`;

export async function run(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const codeFlag = flagString(args.flags, 'code');
  const code = codeFlag ?? (await loadManifest()).code;
  const appId = await resolveAppId(config, code);
  const skipConfirm = flagBool(args.flags, 'yes');

  if (!skipConfirm) {
    if (!input.isTTY) {
      throw new CliError(`Refusing to delete without ${cyan('--yes')} in a non-interactive shell.`);
    }
    warn(`This soft-deletes ${bold(code)} and revokes its installs/tokens.`);
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question(`Type the app code (${code}) to confirm: `);
      if (answer.trim() !== code) {
        throw new CliError('Confirmation did not match — delete aborted.');
      }
    } finally {
      rl.close();
    }
  }

  await apiRequest<void>(config, 'DELETE', `/v1/user-apps/${encodeURIComponent(appId)}`);
  success(`Deleted ${bold(code)}`);
  info('The code stays reserved; create a new app with a different code if you need a replacement.');
}
