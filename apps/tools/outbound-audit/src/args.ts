/** Command-line options. Pure. */

export interface CliOptions {
  days: number;
  /** Workspace id, slug or Clerk org id; null = every active workspace. */
  workspace: string | null;
  /** Markdown file; null = stdout (unless JSON goes to stdout). */
  out: string | null;
  /** JSON file, '-' for stdout, null for no JSON. */
  json: string | null;
  cloudflare: boolean;
  redact: boolean;
  /** Templates, domains and busiest mailbox-days listed per workspace. */
  top: number;
  /** Free label for the report header ("test", "production"). */
  env: string | null;
  help: boolean;
}

export class ArgsError extends Error {}

export const USAGE = `WeldMail outbound audit (read-only)

Usage:
  pnpm audit:outbound [options]

Options:
  --days <n>          Window in days, 1-365 (default 30). Cloudflare data is capped at 31.
  --workspace <id>    Only this workspace (id, slug or Clerk org id).
  --out <file>        Write the markdown report to a file instead of stdout.
  --json [file]       Also write the full JSON report; without a file, JSON goes
                      to stdout instead of the markdown.
  --cloudflare        Add Cloudflare Email Sending analytics per sending domain
                      (needs CLOUDFLARE_API_TOKEN with Analytics Read + Zone Read).
  --redact            Replace workspace names, mailboxes and domains with labels
                      and drop template text, for sharing aggregate numbers.
  --top <n>           Templates, domains and busiest days listed per workspace (default 5).
  --env <label>       Label for the report header, e.g. test or production.
  --help, -h          Show this help.

The output holds customer data. Keep it out of the repository, tickets and chat.`;

function intArg(flag: string, value: string | undefined, min: number, max: number): number {
  if (value === undefined) throw new ArgsError(`${flag} needs a value`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ArgsError(`${flag} must be a whole number from ${min} to ${max}`);
  return n;
}

function stringArg(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) throw new ArgsError(`${flag} needs a value`);
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    days: 30,
    workspace: null,
    out: null,
    json: null,
    cloudflare: false,
    redact: false,
    top: 5,
    env: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--':
        break;
      case '--days':
        options.days = intArg(arg, argv[++i], 1, 365);
        break;
      case '--workspace':
        options.workspace = stringArg(arg, argv[++i]);
        break;
      case '--out':
        options.out = stringArg(arg, argv[++i]);
        break;
      case '--json': {
        const next = argv[i + 1];
        if (next !== undefined && (next === '-' || !next.startsWith('-'))) {
          options.json = next;
          i++;
        } else {
          options.json = '-';
        }
        break;
      }
      case '--cloudflare':
        options.cloudflare = true;
        break;
      case '--redact':
        options.redact = true;
        break;
      case '--top':
        options.top = intArg(arg, argv[++i], 1, 100);
        break;
      case '--env':
        options.env = stringArg(arg, argv[++i]);
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new ArgsError(`Unknown option: ${arg}`);
    }
  }

  if (options.out && options.json && options.out === options.json) {
    throw new ArgsError('--out and --json must name different files');
  }
  return options;
}

/** Where the markdown goes: a file, stdout, or nowhere (JSON took stdout). */
export function markdownTarget(options: CliOptions): 'stdout' | 'none' | { file: string } {
  if (options.out) return { file: options.out };
  return options.json === '-' ? 'none' : 'stdout';
}
