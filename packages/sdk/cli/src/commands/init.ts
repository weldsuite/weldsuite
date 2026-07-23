import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CliError } from '../api.js';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, dim, info, success } from '../log.js';
import { appCodeSchema } from '../manifest.js';
import { copyTemplateDir, templatesRoot } from '../templates.js';

export const help = `${bold('weld app init [dir]')} — scaffold a new WeldSuite app

Creates a Vite + React app wired to @weldsuite/app-sdk, with a weldapp.json
manifest, a CLAUDE.md, and the weldsuite-app Claude skill.

Arguments:
  dir                Target directory (default: current directory)

Options:
  --name <name>      App display name (prompted if omitted)
  --code <code>      App code — lowercase letters, digits, dashes (prompted if omitted)
  --force            Scaffold into a non-empty directory
`;

async function prompt(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback ? ` ${dim(`(${fallback})`)}` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer.length > 0 ? answer : (fallback ?? '');
  } finally {
    rl.close();
  }
}

/** Derive a valid default app code from a display name or directory name. */
function suggestCode(source: string): string {
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '');
  return slug.length >= 3 ? slug.slice(0, 50) : 'my-weld-app';
}

export async function run(args: ParsedArgs): Promise<void> {
  const targetDir = resolve(process.cwd(), args.positionals[0] ?? '.');

  let existing: string[] = [];
  try {
    existing = await readdir(targetDir);
  } catch {
    // Directory does not exist yet — fine, we create it.
  }
  if (existing.length > 0 && !flagBool(args.flags, 'force')) {
    throw new CliError(`${targetDir} is not empty. Pass --force to scaffold anyway.`);
  }

  let name = flagString(args.flags, 'name');
  if (!name) {
    name = await prompt('App name', basename(targetDir));
  }
  if (!name) {
    throw new CliError('An app name is required (pass --name or answer the prompt).');
  }

  let code = flagString(args.flags, 'code');
  if (!code) {
    code = await prompt('App code', suggestCode(name));
  }
  const codeResult = appCodeSchema.safeParse(code);
  if (!codeResult.success) {
    throw new CliError(
      `Invalid app code "${code}": ${codeResult.error.issues[0]?.message ?? 'invalid'}.\n` +
        'Codes are 3-50 chars: lowercase letters, digits and dashes, starting with a letter.',
    );
  }

  const written = await copyTemplateDir(join(templatesRoot(), 'app'), targetDir, {
    APP_NAME: name,
    APP_CODE: codeResult.data,
  });

  success(`Scaffolded ${bold(name)} (${codeResult.data}) — ${written.length} files in ${targetDir}`);
  info('');
  info('Next steps:');
  info(`  ${cyan('npm install')}              install dependencies`);
  info(`  ${cyan('weld app create')}          register the app in your workspace`);
  info(`  ${cyan('weld app deploy')}          build and upload a version`);
  info(`  ${cyan('weld app publish')}         submit it to the public app store (optional)`);
  info('');
  info(`Tip: open this directory with Claude Code — CLAUDE.md and the ${cyan('weldsuite-app')} skill are pre-installed.`);
}
