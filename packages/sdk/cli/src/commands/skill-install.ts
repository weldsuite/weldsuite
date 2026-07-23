import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CliError } from '../api.js';
import { flagBool, type ParsedArgs } from '../args.js';
import { bold, cyan, info, success, warn } from '../log.js';
import { templatesRoot } from '../templates.js';

export const help = `${bold('weld skill install')} — install the weldsuite-app Claude skill

Copies .claude/skills/weldsuite-app/SKILL.md into the current directory and
adds a WeldSuite section to CLAUDE.md (creating it if missing). Idempotent:
already-installed, unmodified files are skipped; locally modified files are
left alone unless --force is passed.

Options:
  --force            Overwrite locally modified files
`;

/** Marker used to detect (and avoid duplicating) our CLAUDE.md section. */
const CLAUDE_MARKER = '<!-- weldsuite-app-skill -->';

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function run(args: ParsedArgs): Promise<void> {
  const force = flagBool(args.flags, 'force');
  const cwd = process.cwd();

  // The skill file is shared with the `weld app init` template so both stay identical.
  const skillSource = join(templatesRoot(), 'app', '_claude', 'skills', 'weldsuite-app', 'SKILL.md');
  const snippetSource = join(templatesRoot(), 'skill', 'CLAUDE-snippet.md');

  const skillContent = await readFile(skillSource, 'utf8');
  const snippetContent = await readFile(snippetSource, 'utf8');

  // 1. Skill file
  const skillDest = join(cwd, '.claude', 'skills', 'weldsuite-app', 'SKILL.md');
  const existingSkill = await readIfExists(skillDest);
  if (existingSkill === skillContent) {
    info(`Skill already up to date: ${cyan('.claude/skills/weldsuite-app/SKILL.md')}`);
  } else if (existingSkill !== null && !force) {
    throw new CliError(
      '.claude/skills/weldsuite-app/SKILL.md exists and differs from the bundled skill.\n' +
        'Pass --force to overwrite your local changes.',
    );
  } else {
    if (existingSkill !== null) {
      warn('Overwriting modified .claude/skills/weldsuite-app/SKILL.md (--force).');
    }
    await mkdir(dirname(skillDest), { recursive: true });
    await writeFile(skillDest, skillContent, 'utf8');
    success(`Installed ${cyan('.claude/skills/weldsuite-app/SKILL.md')}`);
  }

  // 2. CLAUDE.md snippet
  const claudeDest = join(cwd, 'CLAUDE.md');
  const existingClaude = await readIfExists(claudeDest);
  if (existingClaude !== null && existingClaude.includes(CLAUDE_MARKER)) {
    info(`CLAUDE.md already references the weldsuite-app skill.`);
  } else if (existingClaude === null) {
    await writeFile(claudeDest, snippetContent, 'utf8');
    success(`Created ${cyan('CLAUDE.md')} with WeldSuite app guidance.`);
  } else {
    await writeFile(claudeDest, `${existingClaude.replace(/\n*$/, '\n\n')}${snippetContent}`, 'utf8');
    success(`Appended WeldSuite app guidance to ${cyan('CLAUDE.md')}.`);
  }
}
