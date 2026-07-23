#!/usr/bin/env tsx

/**
 * Translate (or bootstrap) one or more locale namespace files.
 *
 *   pnpm tsx scripts/translate-namespace.ts --from en --to fr --namespace helpdesk
 *   pnpm tsx scripts/translate-namespace.ts --from en --to fr --all --dry-run
 *
 * Modes
 *   LLM mode (ANTHROPIC_API_KEY set, no --dry-run):
 *     Sends the source namespace JSON to Claude with a system prompt that
 *     mandates preserving the nested shape, `{placeholder}` syntax, and
 *     brand names (WeldSuite, WeldDesk, WeldFlow, WeldMail, WeldChat,
 *     WeldBooks, WeldCalendar, WeldConnect). Output values that are
 *     ambiguous (≤3 chars, brand-name only) are wrapped in [REVIEW] so
 *     a human can sanity-check before shipping.
 *
 *   --dry-run mode (default when no API key):
 *     Walks the source object and prepends `[TRANSLATE] ` to every string
 *     value. The output passes structural parity validation but is
 *     obviously not user-ready — useful for adding a new language with
 *     full structural coverage that a human (or a follow-up LLM run)
 *     fills in later.
 *
 * Brand names (never translated):
 *   WeldSuite, WeldDesk, WeldFlow, WeldMail, WeldChat, WeldBooks,
 *   WeldCalendar, WeldConnect, WeldAgent, WeldCRM, WeldCommerce,
 *   WeldHost, WeldPay, WeldShip
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRAND_NAMES = [
  'WeldSuite', 'WeldDesk', 'WeldFlow', 'WeldMail', 'WeldChat', 'WeldBooks',
  'WeldCalendar', 'WeldConnect', 'WeldAgent', 'WeldCRM', 'WeldCommerce',
  'WeldHost', 'WeldPay', 'WeldShip',
];

interface Args {
  from: string;
  to: string;
  namespace: string | null;
  all: boolean;
  dryRun: boolean;
  force: boolean;
  apiKey: string | undefined;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };

  const from = get('--from');
  const to = get('--to');
  if (!from || !to) {
    console.error('Usage: translate-namespace.ts --from <locale> --to <locale> (--namespace <name> | --all) [--dry-run] [--force]');
    process.exit(2);
  }

  return {
    from,
    to,
    namespace: get('--namespace'),
    all: argv.includes('--all'),
    dryRun: argv.includes('--dry-run') || !process.env.ANTHROPIC_API_KEY,
    force: argv.includes('--force'),
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
}

function localesDir(): string {
  return path.resolve(__dirname, '..', 'src', 'locales');
}

function listNamespaces(locale: string): string[] {
  const dir = path.join(localesDir(), locale);
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.ts') && f !== 'index.ts')
    .map(f => f.replace(/\.ts$/, ''));
}

async function loadNamespaceValue(locale: string, ns: string): Promise<Record<string, unknown>> {
  const file = path.join(localesDir(), locale, `${ns}.ts`);
  if (!fs.existsSync(file)) {
    throw new Error(`Namespace file not found: ${file}`);
  }
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const value = mod[ns];
  if (!value || typeof value !== 'object') {
    throw new Error(`Expected named export "${ns}" in ${file}, got: ${Object.keys(mod).join(', ')}`);
  }
  return value as Record<string, unknown>;
}

type Tree = string | { [k: string]: Tree };

function isBrandOnly(value: string): boolean {
  const trimmed = value.trim();
  return BRAND_NAMES.some(b => b === trimmed);
}

function shouldFlagForReview(value: string): boolean {
  if (value.length <= 3) return true;
  if (isBrandOnly(value)) return true;
  return false;
}

/** Walk and prepend [TRANSLATE] to every string. Used in dry-run mode. */
function placeholderize(node: Tree): Tree {
  if (typeof node === 'string') return `[TRANSLATE] ${node}`;
  const out: Record<string, Tree> = {};
  for (const [k, v] of Object.entries(node)) out[k] = placeholderize(v);
  return out;
}

interface AnthropicResponse {
  content: Array<{ type: 'text'; text: string } | { type: string; [k: string]: unknown }>;
}

async function llmTranslate(
  apiKey: string,
  source: Record<string, unknown>,
  targetLocale: string
): Promise<Record<string, unknown>> {
  const targetNames: Record<string, string> = {
    fr: 'French (fr-FR)',
    de: 'German (de-DE)',
    es: 'Spanish (es-ES)',
    it: 'Italian (it-IT)',
    pt: 'Portuguese (pt-PT)',
    nl: 'Dutch (nl-NL)',
  };
  const target = targetNames[targetLocale] ?? targetLocale;

  const system = [
    `You are a professional UI translator producing high-quality ${target} strings for the WeldSuite business application.`,
    '',
    'Rules:',
    `- Translate every string value to ${target}.`,
    '- Preserve the JSON object structure EXACTLY. Same keys, same nesting.',
    '- Preserve {placeholder} markers verbatim (no translation, no spacing changes).',
    '- Preserve these brand names untranslated: ' + BRAND_NAMES.join(', ') + '.',
    '- Use the formal/business register appropriate for a professional CRM / accounting / helpdesk product.',
    '- Output ONLY the translated JSON object. No prose, no markdown fences.',
  ].join('\n');

  const user = `Translate these UI strings to ${target}:\n\n${JSON.stringify(source, null, 2)}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${body}`);
  }

  const json = (await response.json()) as AnthropicResponse;
  const text = json.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('')
    .trim();

  // Strip optional ```json fences in case the model adds them.
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Failed to parse LLM response as JSON: ${(e as Error).message}\n\nResponse:\n${text}`);
  }
}

/** Mark values that need human review with [REVIEW] prefix. */
function markForReview(translated: Tree, source: Tree): Tree {
  if (typeof translated === 'string') {
    if (typeof source !== 'string') return translated;
    if (shouldFlagForReview(translated)) return `[REVIEW] ${translated}`;
    return translated;
  }
  const out: Record<string, Tree> = {};
  const src = source as Record<string, Tree>;
  for (const [k, v] of Object.entries(translated)) {
    out[k] = markForReview(v, src[k] ?? '');
  }
  return out;
}

function serialize(name: string, value: unknown): string {
  // JSON.stringify produces double-quoted strings. Valid TypeScript;
  // matches no existing locale's style exactly but compiles cleanly.
  return `export const ${name} = ${JSON.stringify(value, null, 2)};\n`;
}

function writeBarrel(locale: string, namespaces: string[]): void {
  const dir = path.join(localesDir(), locale);
  const imports = namespaces.map(n => `import { ${n} } from './${n}';`).join('\n');
  const fields = namespaces.map(n => `  ${n},`).join('\n');
  const content = `${imports}\n\nexport const ${locale} = {\n${fields}\n};\n`;
  fs.writeFileSync(path.join(dir, 'index.ts'), content);
}

async function processNamespace(args: Args, ns: string): Promise<void> {
  const targetFile = path.join(localesDir(), args.to, `${ns}.ts`);
  if (fs.existsSync(targetFile) && !args.force) {
    console.log(`  ⊘ ${ns}: target exists, skipping (pass --force to overwrite)`);
    return;
  }

  const source = await loadNamespaceValue(args.from, ns);

  let translated: Record<string, unknown>;
  if (args.dryRun) {
    translated = placeholderize(source as Tree) as Record<string, unknown>;
    console.log(`  ✓ ${ns}: dry-run placeholders`);
  } else {
    if (!args.apiKey) throw new Error('LLM mode requires ANTHROPIC_API_KEY');
    const raw = await llmTranslate(args.apiKey, source, args.to);
    translated = markForReview(raw as Tree, source as Tree) as Record<string, unknown>;
    console.log(`  ✓ ${ns}: LLM-translated (${args.to})`);
  }

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, serialize(ns, translated));
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.dryRun && !args.apiKey) {
    console.log('ℹ️  Running in --dry-run mode (no ANTHROPIC_API_KEY set).');
    console.log('   Output will contain [TRANSLATE] placeholders.\n');
  }

  const sourceNamespaces = listNamespaces(args.from);
  const targets = args.all
    ? sourceNamespaces
    : args.namespace
      ? [args.namespace]
      : [];

  if (targets.length === 0) {
    console.error('Must pass either --namespace <name> or --all.');
    process.exit(2);
  }

  console.log(`${args.from} → ${args.to}: ${targets.length} namespace(s)\n`);

  for (const ns of targets) {
    if (!sourceNamespaces.includes(ns)) {
      console.error(`  ✗ ${ns}: not found in ${args.from}/`);
      continue;
    }
    await processNamespace(args, ns);
  }

  // Regenerate the barrel in the target locale.
  const targetNamespaces = listNamespaces(args.to);
  writeBarrel(args.to, targetNamespaces);
  console.log(`\n✓ Wrote ${args.to}/index.ts with ${targetNamespaces.length} namespace(s)`);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
