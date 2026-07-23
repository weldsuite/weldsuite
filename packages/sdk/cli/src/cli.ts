#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { CliError } from './api.js';
import { parseArgs, type ParsedArgs } from './args.js';
import { bold, cyan, error as logError, info } from './log.js';
import * as appCreate from './commands/create.js';
import * as appDeploy from './commands/deploy.js';
import * as appInit from './commands/init.js';
import * as appList from './commands/list.js';
import * as appPublish from './commands/publish.js';
import * as skillInstall from './commands/skill-install.js';

interface Command {
  help: string;
  run(args: ParsedArgs): Promise<void>;
}

const COMMANDS: Record<string, Command> = {
  'app init': appInit,
  'app create': appCreate,
  'app deploy': appDeploy,
  'app publish': appPublish,
  'app list': appList,
  'skill install': skillInstall,
};

const HELP = `${bold('weld')} — the WeldSuite app CLI

Usage:
  ${cyan('weld <command> [options]')}

App commands:
  app init [dir]        Scaffold a new WeldSuite app (Vite + React + app-sdk)
  app create            Register the app from weldapp.json in your workspace
  app deploy            Build the app and upload a new version
  app publish           Submit the app for public-store review
  app list              List your workspace's apps

Skill commands:
  skill install         Install the weldsuite-app Claude skill into ./.claude/

Global options:
  --help, -h            Show help (also works per command: weld app deploy --help)
  --version, -v         Show the CLI version

Environment:
  WELD_API_KEY          Workspace API key (wsk_…) — required for API commands
  WELD_API_URL          API base URL (default: https://api.weldsuite.org)
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--version') || argv.includes('-v')) {
    info(readVersion());
    return;
  }

  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  const words = argv.filter((token) => !token.startsWith('-'));
  const commandName = words.slice(0, 2).join(' ');
  const command = COMMANDS[commandName];

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

  // Strip the two command words, keep the rest (flags + extra positionals).
  const rest: string[] = [];
  let skipped = 0;
  for (const token of argv) {
    if (skipped < 2 && !token.startsWith('-')) {
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
