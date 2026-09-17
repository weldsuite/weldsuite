import { bold, cyan, info, success } from '../log.js';
import { clearCredentials, credentialsPath, readCredentials } from '../credentials.js';
import type { ParsedArgs } from '../args.js';

export const help = `${bold('weld logout')} — remove the local CLI login session

Deletes ~/.config/weldsuite/credentials.json (or $XDG_CONFIG_HOME/weldsuite/).
Does not revoke the personal API key on the server — remove “Weld CLI” under
Settings → API keys if you want it gone.

Usage:
  ${cyan('weld logout')}
`;

export async function run(_args: ParsedArgs): Promise<void> {
  const existing = readCredentials();
  const removed = clearCredentials();
  if (!removed && !existing) {
    info('No local credentials to remove.');
    return;
  }
  success(`Logged out. Removed ${cyan(credentialsPath())}`);
  if (existing?.keyPrefix) {
    info(
      `Optional: revoke key ${existing.keyPrefix}… named “Weld CLI” in Settings → API keys.`,
    );
  }
}
