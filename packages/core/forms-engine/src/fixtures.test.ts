/// <reference types="node" />
/**
 * Runs the shared fixtures (`fixtures/*.json` and `fixtures/invalid/*.json`).
 * The Rust module runs the same files, so both backends decide alike.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findField } from './blocks';
import type { Answers } from './definition';
import { displayAnswer, searchText } from './display';
import { computePath } from './path';
import { recall } from './recall';
import { evaluateSubmission } from './submission';
import type { SubmissionResult, VariableValues } from './types';
import { parseDefinition } from './validate';

interface FixtureCase {
  name: string;
  answers: Answers;
  hidden?: Record<string, string>;
  expect: SubmissionResult;
}

interface RecallCase {
  name: string;
  text: string;
  answers: Answers;
  hidden?: Record<string, string>;
  variables?: VariableValues;
  encode?: boolean;
  expect: string;
}

interface DisplayCase {
  name: string;
  fieldId: string;
  value: unknown;
  expect: string;
}

interface SearchTextCase {
  name: string;
  answers: Record<string, unknown>;
  expect: string;
}

interface Fixture {
  name: string;
  definition: unknown;
  cases: FixtureCase[];
  recall?: RecallCase[];
  display?: DisplayCase[];
  searchText?: SearchTextCase[];
}

interface InvalidFixture {
  name: string;
  definition: unknown;
  expectIssues: string[];
  /** Optional: the issues exactly, in order (code, path, message). */
  expectDetails?: Array<{ code: string; path: string; message: string }>;
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

describe('fixtures', () => {
  const files = jsonFiles(fixturesDir);

  it('has at least ten fixture files', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    const fixture = readJson<Fixture>(join(fixturesDir, file));
    describe(`${file}: ${fixture.name}`, () => {
      const parsed = parseDefinition(fixture.definition);

      it('has a valid definition', () => {
        expect(parsed.ok ? [] : parsed.issues).toEqual([]);
      });

      for (const c of fixture.cases) {
        it(c.name, () => {
          if (!parsed.ok) throw new Error('invalid definition');
          const result = evaluateSubmission(parsed.definition, { answers: c.answers, hidden: c.hidden });
          expect(result).toEqual(c.expect);
          // Same path, ending and variables from computePath.
          expect(computePath(parsed.definition, { answers: c.answers, hidden: c.hidden })).toEqual({
            path: c.expect.path,
            endingId: c.expect.endingId,
            variables: c.expect.variables,
          });
        });
      }

      for (const c of fixture.recall ?? []) {
        it(`recall: ${c.name}`, () => {
          if (!parsed.ok) throw new Error('invalid definition');
          const ctx = { answers: c.answers, hidden: c.hidden, variables: c.variables };
          expect(recall(c.text, parsed.definition, ctx, { encode: c.encode })).toBe(c.expect);
        });
      }

      for (const c of fixture.display ?? []) {
        it(`display: ${c.name}`, () => {
          if (!parsed.ok) throw new Error('invalid definition');
          const field = findField(parsed.definition, c.fieldId);
          if (!field) throw new Error(`no field ${c.fieldId}`);
          expect(displayAnswer(field, c.value)).toBe(c.expect);
        });
      }

      for (const c of fixture.searchText ?? []) {
        it(`searchText: ${c.name}`, () => {
          if (!parsed.ok) throw new Error('invalid definition');
          expect(searchText(parsed.definition, c.answers)).toBe(c.expect);
        });
      }
    });
  }
});

describe('invalid fixtures', () => {
  const dir = join(fixturesDir, 'invalid');
  const files = jsonFiles(dir);

  for (const file of files) {
    const fixture = readJson<InvalidFixture>(join(dir, file));
    it(`${file}: ${fixture.name}`, () => {
      const parsed = parseDefinition(fixture.definition);
      const issues = parsed.ok ? [] : parsed.issues;
      const codes = issues.map((i) => i.code);
      expect([...codes].sort()).toEqual([...fixture.expectIssues].sort());
      if (fixture.expectDetails) {
        expect(issues.map(({ code, path, message }) => ({ code, path, message }))).toEqual(fixture.expectDetails);
      }
    });
  }

  it('covers every issue code', () => {
    const covered = new Set(files.flatMap((f) => readJson<InvalidFixture>(join(dir, f)).expectIssues));
    const all = [
      'schema',
      'duplicate_id',
      'duplicate_ref',
      'duplicate_hidden',
      'duplicate_variable',
      'reserved_variable',
      'unknown_block',
      'unknown_ending',
      'unknown_field',
      'unknown_row',
      'unknown_part',
      'unknown_hidden',
      'unknown_variable',
      'variable_type',
      'logic_on_page_break',
      'duplicate_logic',
      'backward_jump',
      'operand_after_source',
      'operator_mismatch',
      'selection_range',
      'number_range',
      'date_range',
    ];
    expect(all.filter((code) => !covered.has(code))).toEqual([]);
  });
});
