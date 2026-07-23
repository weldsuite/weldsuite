/** Tiny hand-rolled argument parser — no dependencies. */

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parse `--flag`, `--flag value`, and `--flag=value` tokens; everything else
 * is a positional. A value is consumed only when the next token does not
 * start with `--`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      if (equalsIndex !== -1) {
        flags[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
        continue;
      }
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        index += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

/** Read a string-valued flag; `--flag` without a value returns undefined. */
export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** Read a boolean flag; present (with or without value) counts as true. */
export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] !== undefined && flags[name] !== false;
}
