/**
 * The SQL corpus (`__corpus__/sql-corpus.json`) for the Rust backend: every
 * statement the query layer and panel-api send to Basin, with the input that
 * produced each `compiler` statement. This test rebuilds it from
 * `__corpus__/cases.ts` and fails when the file is stale;
 * `UPDATE_SQL_CORPUS=1 pnpm --filter @weldsuite/panel-domain test corpus`
 * rewrites it. See `__corpus__/README.md`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPILER_CASES, PANEL_API_CASES, type CompilerCase } from './__corpus__/cases';
import {
  CORPUS_VERSION,
  compileInput,
  corpusInputSchema,
  jsonCopy,
  serializeCorpus,
  sortKeys,
  statementOf,
  type CorpusEntry,
} from './__corpus__/corpus';

const CORPUS_FILE = join(dirname(fileURLToPath(import.meta.url)), '__corpus__', 'sql-corpus.json');
const UPDATE = process.env.UPDATE_SQL_CORPUS === '1';

const canonical = (value: unknown) => JSON.stringify(sortKeys(value));

/** A case as the file stores it: the parsed input (only the responses the runner asked for) and what it compiles to. */
async function compilerEntry(item: CompilerCase): Promise<CorpusEntry> {
  let parsed = corpusInputSchema.parse(item.input);
  if (parsed.call === 'runPanelQuery') {
    const asked = new Set((await compileInput(parsed)).map((q) => q.name));
    const responses = Object.fromEntries(Object.entries(parsed.responses).filter(([name]) => asked.has(name)));
    parsed = { ...parsed, responses };
  }
  // Compiled from what a reader of the file gets back, so the stored input is all it takes.
  const stored = jsonCopy(parsed);
  const reread = corpusInputSchema.parse(stored);
  if (canonical(jsonCopy(reread)) !== canonical(stored)) throw new Error(`${item.id}: the stored input is not fully parsed`);
  const statements = (await compileInput(reread)).map(statementOf);
  if (statements.length === 0) throw new Error(`${item.id}: compiles to no statements`);
  return { id: item.id, source: 'compiler', input: stored, statements };
}

async function buildCorpus(): Promise<CorpusEntry[]> {
  const compiled: CorpusEntry[] = [];
  for (const item of COMPILER_CASES) compiled.push(await compilerEntry(item));
  const panelApi: CorpusEntry[] = PANEL_API_CASES.map((item) => ({
    id: item.id,
    source: 'panel-api',
    input: null,
    statements: item.statements.map(statementOf),
  }));
  return [...compiled, ...panelApi];
}

/** Entry text by id, from a corpus file's text. */
function entriesById(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const entries = parsed !== null && typeof parsed === 'object' && 'entries' in parsed ? parsed.entries : null;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object' && 'id' in entry) out.set(String(entry.id), JSON.stringify(entry));
  }
  return out;
}

/** What changed between the file and the build, for the failure message. */
function describeDrift(current: string, fresh: string): string {
  const before = entriesById(current);
  const after = entriesById(fresh);
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id));
  const list = (label: string, ids: string[]) => (ids.length > 0 ? `\n${label} (${ids.length}): ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ', ...' : ''}` : '');
  return (
    'sql-corpus.json is stale: run `UPDATE_SQL_CORPUS=1 pnpm --filter @weldsuite/panel-domain test corpus` and commit it.' +
    list('new', added) +
    list('removed', removed) +
    list('changed', changed)
  );
}

describe('the SQL corpus', () => {
  it('has one entry per id', () => {
    const ids = [...COMPILER_CASES.map((c) => c.id), ...PANEL_API_CASES.map((c) => c.id)];
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  it('matches the compiler (UPDATE_SQL_CORPUS=1 rewrites it)', { timeout: 120_000 }, async () => {
    const entries = await buildCorpus();
    const text = serializeCorpus(entries);
    if (UPDATE) {
      writeFileSync(CORPUS_FILE, text);
      return;
    }
    // A Windows checkout may have turned the line ends into CRLF; a CR inside a value is always escaped (`\r`).
    const current = existsSync(CORPUS_FILE) ? readFileSync(CORPUS_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== text) expect.fail(describeDrift(current, text));

    const file = JSON.parse(current) as { version: number; entries: CorpusEntry[] };
    expect(file.version).toBe(CORPUS_VERSION);
    for (const entry of file.entries) {
      expect(entry.statements.length, entry.id).toBeGreaterThan(0);
      for (const statement of entry.statements) expect(statement.columns.length, `${entry.id} ${statement.name}`).toBeGreaterThan(0);
    }
  });
});
