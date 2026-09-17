import { apiRequest, ApiError, loadConfig, resolveAppId } from '../api.js';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, info, success, warn } from '../log.js';
import { loadManifest } from '../manifest.js';

export const help = `${bold('weld app oauth')} — create, rotate, or show the OAuth client

Server-to-server credentials for your app backend
(GET/POST /v1/user-apps/:id/oauth-client). The client secret is shown once
on create/rotate — store it immediately.

Options:
  --code <code>     App code (default: weldapp.json)
  --create          Create or rotate the client secret (default when none exists)
  --rotate          Force rotate (same as --create when a client already exists)
  --show            Print the client id only (secret is never returned again)

Requires weld login (or WELD_API_KEY).
`;

interface OauthClientMeta {
  clientId?: string;
  createdAt?: string;
}

interface OauthClientSecret {
  clientId?: string;
  clientSecret?: string;
}

export async function run(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const codeFlag = flagString(args.flags, 'code');
  const code = codeFlag ?? (await loadManifest()).code;
  const appId = await resolveAppId(config, code);
  const path = `/v1/user-apps/${encodeURIComponent(appId)}/oauth-client`;

  const showOnly = flagBool(args.flags, 'show');
  const forceWrite = flagBool(args.flags, 'create') || flagBool(args.flags, 'rotate');

  if (showOnly && !forceWrite) {
    try {
      const client = await apiRequest<OauthClientMeta>(config, 'GET', path);
      info(`${bold('Client ID')}  ${client.clientId ?? '-'}`);
      if (client.createdAt) {
        info(`${bold('Created')}    ${client.createdAt}`);
      }
      info(cyan('Secret is only shown at create/rotate time.'));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        info(`No OAuth client yet for ${bold(code)}. Run ${cyan('weld app oauth --create')}.`);
        return;
      }
      throw cause;
    }
    return;
  }

  let existing: OauthClientMeta | null = null;
  try {
    existing = await apiRequest<OauthClientMeta>(config, 'GET', path);
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 404)) {
      throw cause;
    }
  }

  if (existing && !forceWrite && !showOnly) {
    info(`${bold('Client ID')}  ${existing.clientId ?? '-'}`);
    info(`Already exists. Pass ${cyan('--rotate')} to mint a new secret, or ${cyan('--show')}.`);
    return;
  }

  const created = await apiRequest<OauthClientSecret>(config, 'POST', path);
  success(existing ? `Rotated OAuth client for ${bold(code)}` : `Created OAuth client for ${bold(code)}`);
  info(`${bold('Client ID')}      ${created.clientId ?? '-'}`);
  info(`${bold('Client secret')}  ${created.clientSecret ?? '-'}`);
  warn('Store the secret now — it will not be shown again.');
}
