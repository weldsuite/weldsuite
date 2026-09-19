#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { CliError } from './api.js';
import { parseArgs, type ParsedArgs } from './args.js';
import { bold, cyan, error as logError, info } from './log.js';
import * as appCreate from './commands/create.js';
import * as appDelete from './commands/delete.js';
import * as appDeploy from './commands/deploy.js';
import * as appDev from './commands/dev.js';
import * as appInfo from './commands/info.js';
import * as appInit from './commands/init.js';
import * as appList from './commands/list.js';
import * as appOauth from './commands/oauth.js';
import * as appPublish from './commands/publish.js';
import * as appUpdate from './commands/update.js';
import * as appVersions from './commands/versions.js';
import * as skillInstall from './commands/skill-install.js';
import * as login from './commands/login.js';
import * as logout from './commands/logout.js';
import * as whoami from './commands/whoami.js';

interface Command {
  help: string;
  run(args: ParsedArgs): Promise<void>;
}

const COMMANDS: Record<string, Command> = {
  login,
  logout,
  whoami,
  'app init': appInit,
  'app create': appCreate,
  'app info': appInfo,
  'app list': appList,
  'app update': appUpdate,
  'app versions': appVersions,
  'app dev': appDev,
  'app deploy': appDeploy,
  'app publish': appPublish,
  'app oauth': appOauth,
  'app delete': appDelete,
  'skill install': skillInstall,
};

const HELP = `${bold('weld')} — the WeldSuite app CLI

Usage:
  ${cyan('weld <command> [options]')}

Auth:
  login                 Sign in via browser (device code) and store credentials
  logout                Remove the local login session
  whoami                Show the active identity [--check]

App commands:
  app init [dir]        Scaffold a new WeldSuite app (Vite + React + app-sdk)
  app create [dir]      Scaffold if needed, then register the app in your workspace
  app info              Show one app's metadata (visibility, review, listing)
  app list              List your workspace's apps
  app update            Patch metadata (from weldapp.json or flags)
  app versions          List uploaded versions
  app dev               Local shell + Vite preview (optional --tunnel for hosted platform)
  app deploy            Build the app and upload a new version
  app publish           Submit the app for public-store review (sets visibility public)
  app oauth             Create, rotate, or show the app OAuth client
  app delete            Soft-delete the app (--yes to skip confirm)

Skill commands:
  skill install         Install the weldsuite-app Claude skill into ./.claude/

Global options:
  --help, -h            Show help (also works per command: weld app deploy --help)
  --version, -v         Show the CLI version

Environment:
  WELD_API_KEY          Optional override — workspace/personal API key (wsk_…) for CI
  WELD_API_URL          External API base URL (default: https://api.weldsuite.org)
  WELD_APP_API_URL      app-api base for weld login (default: derived from WELD_API_URL)
  WELD_LOGIN_URL        Developer portal origin for weld login
  WELD_DEV_USER_ID      Clerk user id for weld app dev (required with workspace keys)
  WELD_PLATFORM_URL     Platform SPA origin for /apps/{code} deep links

Auth note:
  Prefer ${cyan('weld login')} (Clerk device code → personal wsk_…).
  For CI, set WELD_API_KEY to a workspace/personal key with user-apps:manage.
  The developer portal remains optional for the same manage flows.
`;

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Single-word auth commands vs two-word app/skill commands. */
function resolveCommand(words: string[]): { name: string; arity: number; command: Command | undefined } {
  if (words.length >= 1) {
    const single = words[0] ?? '';
    if (COMMANDS[single] && !single.includes(' ')) {
      // Prefer exact single-token commands (login/logout/whoami) over "app …".
      if (single === 'login' || single === 'logout' || single === 'whoami') {
        return { name: single, arity: 1, command: COMMANDS[single] };
      }
    }
  }
  const two = words.slice(0, 2).join(' ');
  if (COMMANDS[two]) return { name: two, arity: 2, command: COMMANDS[two] };
  const one = words[0] ?? '';
  if (COMMANDS[one]) return { name: one, arity: 1, command: COMMANDS[one] };
  return { name: two || one, arity: 2, command: undefined };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--version') || argv.includes('-v')) {
    info(readVersion());
    return;
  }

  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  const words = argv.filter((token) => !token.startsWith('-'));
  const { arity, command } = resolveCommand(words);

  if (!command) {
    info(HELP);
    if (argv.length > 0 && !wantsHelp) {
      throw new CliError(`Unknown command: ${argv.join(' ')}`);
    }
    return;
  }

  if (wantsHelp) {
    info(command.help);
    return;
  }

  // Strip the command word(s), keep the rest (flags + extra positionals).
  const rest: string[] = [];
  let skipped = 0;
  for (const token of argv) {
    if (skipped < arity && !token.startsWith('-')) {
      skipped += 1;
      continue;
    }
    rest.push(token);
  }

  await command.run(parseArgs(rest));
}

main().catch((cause: unknown) => {
  if (cause instanceof CliError) {
    logError(cause.message);
  } else if (cause instanceof Error) {
    logError(cause.stack ?? cause.message);
  } else {
    logError(String(cause));
  }
  process.exitCode = 1;
});
