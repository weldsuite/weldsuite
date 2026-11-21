/**
 * `$filter` of the OData feed: the parser (grammar, precedence, quoting, dates,
 * functions, `any`, type checks, limits) and the SQL it compiles to. No
 * database: the SQL is rendered and its text and bound parameters are checked,
 * above all that nothing from the request reaches the text.
 */

import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { findEntitySet, type ODataEntitySet } from '../routes/v1/odata/catalog';
import { ODataError } from '../routes/v1/odata/errors';
import { parseFilter, type FilterNode } from '../routes/v1/odata/filter';
import { escapeLike, filterToSql } from '../routes/v1/odata/filter-sql';

const set = findEntitySet('Conversations')!;
const parse = (text: string): FilterNode => parseFilter(text, set);

function failure(text: string): ODataError {
  try {
    parse(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ODataError);
    return error as ODataError;
  }
  throw new Error(`expected ${JSON.stringify(text)} to be refused`);
}

const rejects = (text: string, status: 400 | 501 = 400) => expect(failure(text).status, text).toBe(status);

function render(text: string) {
  return new PgDialect().sqlToQuery(filterToSql(parse(text), set));
}

/** Conversations with a property of every other type the catalogue can declare, and one that is not filterable. */
const typed: ODataEntitySet = {
  ...set,
  properties: [
    ...set.properties,
    { name: 'big', column: 'big', type: 'Edm.Int64', nullable: true, filterable: true, sortable: true },
    { name: 'ratio', column: 'ratio', type: 'Edm.Double', nullable: true, filterable: true, sortable: true },
    { name: 'hidden', column: 'hidden', type: 'Edm.String', nullable: true, filterable: false, sortable: false },
  ],
};

/** What a filter is read as: the tree as JSON (a property by its name), or `<status> <message>` when it is refused. */
function outcome(text: string): string {
  try {
    return JSON.stringify(parseFilter(text, typed), (key, value: unknown) => (key === 'prop' ? (value as { name: string }).name : value));
  } catch (error) {
    if (error instanceof ODataError) return `${error.status} ${error.message}`;
    throw error;
  }
}

describe('parser', () => {
  it('gives and a higher precedence than or', () => {
    const node = parse("state eq 'a' or state eq 'b' and channel eq 'c'");
    expect(node.kind).toBe('or');
    if (node.kind !== 'or') return;
    expect(node.args.map((a) => a.kind)).toEqual(['cmp', 'and']);
  });

  it('lets parentheses override precedence', () => {
    const node = parse("(state eq 'a' or state eq 'b') and channel eq 'c'");
    expect(node.kind).toBe('and');
    if (node.kind !== 'and') return;
    expect(node.args.map((a) => a.kind)).toEqual(['or', 'cmp']);
  });

  it('binds not tighter than and, and nests it', () => {
    const node = parse("not state eq 'a' and not not channel eq 'c'");
    expect(node.kind).toBe('and');
    if (node.kind !== 'and') return;
    expect(node.args.map((a) => a.kind)).toEqual(['not', 'not']);
    expect(parse("not (state eq 'a' or state eq 'b')").kind).toBe('not');
  });

  it('flattens a chain of the same operator', () => {
    const node = parse("state eq 'a' and channel eq 'b' and priority eq 'c'");
    expect(node.kind === 'and' && node.args.length).toBe(3);
  });

  it('reads strings with doubled quotes, the empty string and special characters', () => {
    expect(parse("title eq 'it''s'")).toMatchObject({ lit: { type: 'string', value: "it's" } });
    expect(parse("title eq ''")).toMatchObject({ lit: { type: 'string', value: '' } });
    expect(parse("title eq ''''")).toMatchObject({ lit: { type: 'string', value: "'" } });
    expect(parse("title eq 'a and b (c) eq'")).toMatchObject({ lit: { type: 'string', value: 'a and b (c) eq' } });
  });

  it('reads null on either side of eq and ne', () => {
    expect(parse('title eq null')).toMatchObject({ op: 'eq', lit: { type: 'null' } });
    expect(parse('null ne title')).toMatchObject({ op: 'ne', lit: { type: 'null' } });
    rejects('title gt null');
    rejects('null lt rating');
  });

  it('accepts the literal on the left and flips the operator', () => {
    expect(parse('5 lt rating')).toMatchObject({ op: 'gt', prop: { name: 'rating' }, lit: { value: 5 } });
    expect(parse('5 ge rating')).toMatchObject({ op: 'le' });
    expect(parse("'open' eq state")).toMatchObject({ op: 'eq', prop: { name: 'state' } });
  });

  it('reads integers, negatives and booleans', () => {
    expect(parse('rating ge -3')).toMatchObject({ lit: { type: 'int', value: -3 } });
    expect(parse('rating eq 0')).toMatchObject({ lit: { type: 'int', value: 0 } });
    expect(parse('isMajorIncident eq true')).toMatchObject({ lit: { type: 'boolean', value: true } });
    expect(parse('isMajorIncident ne false')).toMatchObject({ lit: { type: 'boolean', value: false } });
  });

  it('reads date-times in UTC, with an offset, with fractions, and bare dates', () => {
    expect(parse('createdAt ge 2026-01-31T00:00:00Z')).toMatchObject({ lit: { type: 'datetime', ts: '2026-01-31 00:00:00.000' } });
    expect(parse('createdAt ge 2026-01-31T10:30:00+02:00')).toMatchObject({ lit: { ts: '2026-01-31 08:30:00.000' } });
    expect(parse('createdAt ge 2026-01-31T10:30:00-05:00')).toMatchObject({ lit: { ts: '2026-01-31 15:30:00.000' } });
    // an unescaped `+` arrives as a space
    expect(parse('createdAt ge 2026-01-31T10:30:00 02:00')).toMatchObject({ lit: { ts: '2026-01-31 08:30:00.000' } });
    expect(parse('createdAt ge 2026-01-31T00:00:00.123456Z')).toMatchObject({ lit: { ts: '2026-01-31 00:00:00.123' } });
    expect(parse('createdAt ge 2026-01-31T09:15Z')).toMatchObject({ lit: { ts: '2026-01-31 09:15:00.000' } });
    expect(parse('createdAt ge 2026-01-31T09:15:00')).toMatchObject({ lit: { ts: '2026-01-31 09:15:00.000' } });
    expect(parse('createdAt ge 2026-01-31')).toMatchObject({
      lit: { type: 'datetime', ts: '2026-01-31 00:00:00.000', dayEnd: '2026-02-01 00:00:00.000' },
    });
    expect(parse('createdAt lt 2024-02-29')).toMatchObject({ lit: { dayEnd: '2024-03-01 00:00:00.000' } });
  });

  it('refuses impossible dates and times', () => {
    for (const text of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-01-31T24:00:00Z', '2026-01-31T10:60:00Z', '2026-01-31T10:00:60Z', '0001-01-01T00:00:00+05:00']) {
      const filter = `createdAt eq ${text}`;
      expect(failure(filter).status, filter).toBe(400);
    }
  });

  it('reads the functions contains, startswith, endswith', () => {
    expect(parse("contains(title,'x')")).toMatchObject({ kind: 'text', fn: 'contains', value: 'x' });
    expect(parse("startswith(title, 'x')")).toMatchObject({ kind: 'text', fn: 'startswith' });
    expect(parse("endswith( email , 'x.test' )")).toMatchObject({ kind: 'text', fn: 'endswith', prop: { name: 'email' } });
    expect(parse("not contains(title,'x')").kind).toBe('not');
  });

  it('reads year, month and day of a date property', () => {
    expect(parse('year(createdAt) eq 2026')).toMatchObject({ kind: 'cmp', fn: 'year', lit: { value: 2026 } });
    expect(parse('month(createdAt) ge 6')).toMatchObject({ fn: 'month', op: 'ge' });
    expect(parse('3 gt day(createdAt)')).toMatchObject({ fn: 'day', op: 'lt' });
    rejects('year(title) eq 2026');
    rejects("year(createdAt) eq '2026'");
    rejects('year(createdAt)');
  });

  it('reads any() on a collection and nothing else on one', () => {
    expect(parse("tags/any(t: t eq 'vip')")).toMatchObject({ kind: 'any', prop: { name: 'tags' }, value: 'vip' });
    expect(parse("tags/any(x:x eq 'it''s')")).toMatchObject({ value: "it's" });
    rejects("tags eq 'vip'");
    rejects('tags/any(t: t eq 5)');
    rejects("title/any(t: t eq 'x')");
    rejects("contains(tags,'x')");
    rejects("tags/all(t: t eq 'x')", 501);
    rejects("tags/any(t: t ne 'x')", 501);
    rejects("tags/any(t: u eq 'x')", 501);
    rejects('tags/any()', 501);
    rejects('tags/$count gt 1', 400);
    rejects('title/length gt 1', 501);
  });

  it('answers 501 for another function, 400 for an unknown property', () => {
    const cases: Array<[string, 400 | 501]> = [
      ["tolower(title) eq 'a'", 501],
      ['length(title) gt 3', 501],
      ["substringof('a', title)", 501],
      ["concat(title,'a') eq 'b'", 501],
      ["cast(title, 'Edm.Int32') eq 1", 501],
      ["nope eq 'a'", 400],
      ["Title eq 'a'", 400],
      ["title eq 'a' and nope eq 1", 400],
    ];
    for (const [text, status] of cases) expect(failure(text).status, text).toBe(status);
  });

  it('refuses a literal of the wrong type', () => {
    rejects('title eq 5');
    rejects("conversationNumber eq 'x'");
    rejects('conversationNumber eq 1.5');
    rejects('conversationNumber eq true');
    rejects('conversationNumber eq 2147483648');
    rejects("isMajorIncident eq 'true'");
    rejects('isMajorIncident gt true');
    rejects('createdAt eq 5');
    rejects("createdAt eq 'yesterday'");
    rejects('title eq 2026-01-31');
    rejects('title eq false');
    expect(parse('conversationNumber eq 2147483647')).toBeTruthy();
  });

  it('refuses comparisons that are not property against literal', () => {
    for (const text of ["'a' eq 'b'", 'title eq state', '1 eq 1', "contains(title,'a') eq true", 'isMajorIncident', 'true', "'x'"]) {
      expect(failure(text).status, text).toBe(400);
    }
  });

  it('refuses malformed input', () => {
    for (const text of [
      '',
      '   ',
      'title eq',
      "title eq 'x",
      "(title eq 'x'",
      "title eq 'x')",
      "title == 'x'",
      "title eq 'x' and",
      "and title eq 'x'",
      "title eq 'x' title eq 'y'",
      "title EQ 'x'",
      "state eq 'a' AND state eq 'b'",
      'title.length eq 1',
      "title eq 'x';",
      'title eq $it',
      'title eq @a',
      'title eq 12abc',
      'rating eq 1e',
      'rating eq 99999999999999999999',
      'contains(title)',
      "contains(title,'a','b')",
      "contains('a',title)",
      'contains(title,state)',
      "contains(title,'a'",
      'title eq 2026-01-31Tx',
    ]) {
      expect(failure(text).status, text).toBe(400);
    }
  });

  it('enforces the length, depth and comparison limits', () => {
    rejects(`title eq '${'x'.repeat(2000)}'`);
    expect(parse(`title eq '${'x'.repeat(1980)}'`)).toBeTruthy();

    const nest = (depth: number) => `${'('.repeat(depth)}state eq 'a'${')'.repeat(depth)}`;
    expect(parse(nest(10))).toBeTruthy();
    rejects(nest(11));
    rejects(nest(400));
    expect(parse(`${'not '.repeat(9)}state eq 'a'`)).toBeTruthy();
    rejects(`${'not '.repeat(11)}state eq 'a'`);

    const many = (n: number) => Array.from({ length: n }, (_, i) => `rating eq ${i}`).join(' or ');
    expect(parse(many(30))).toBeTruthy();
    rejects(many(31));
  });
});

// Every shape of token and every literal check, with the message a refusal carries: the Rust port answers the same.
describe('tokens and literal checks', () => {
  it.each<[string, string]>([
    ['createdAt ge 2026-01-31', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 00:00:00.000","dayEnd":"2026-02-01 00:00:00.000"}}'],
    ['createdAt ge 2026-01-31T10:30', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 10:30:00.000"}}'],
    ['createdAt ge 2026-01-31T10:30Z', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 10:30:00.000"}}'],
    ['createdAt ge 2026-01-31T10:30:15', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 10:30:15.000"}}'],
    ['createdAt ge 2026-01-31T10:30:15.5', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 10:30:15.500"}}'],
    ['createdAt ge 2026-01-31T10:30:15.123456789Z', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 10:30:15.123"}}'],
    ['createdAt ge 2026-01-31T10:30:15.1234567891Z', "400 Unexpected character '1' in $filter"],
    ['createdAt ge 2026-01-31T10:30+02:00', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 08:30:00.000"}}'],
    ['createdAt ge 2026-01-31T10:30:15.25-05:30', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 16:00:15.250"}}'],
    ['createdAt ge 2026-01-31T10:30 02:00', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 08:30:00.000"}}'],
    ['createdAt ge 2026-01-31T10:30:15 02:00', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 08:30:15.000"}}'],
    ['createdAt ge 2026-01-31T10:30:15.5 02:00', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 08:30:15.500"}}'],
    ['createdAt ge 2026-01-31T23:59:59+25:99', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-30 21:20:59.000"}}'],
    ['createdAt ge 2026-01-31Z', "400 Unexpected character 'Z' in $filter"],
    ['createdAt ge 2026-01-31T', "400 Unexpected character 'T' in $filter"],
    ['createdAt ge 2026-01-31T10', "400 Unexpected character 'T' in $filter"],
    ['createdAt ge 2026-01-31T10:', "400 Unexpected character 'T' in $filter"],
    ['createdAt ge 2026-01-31T10:3', "400 Unexpected character 'T' in $filter"],
    ['createdAt ge 2026-01-31T10:30:', "400 Unexpected ':' in $filter"],
    ['createdAt ge 2026-01-31T10:30:1', "400 Unexpected ':' in $filter"],
    ['createdAt ge 2026-01-31T10:30:15.', "400 Unexpected character '.' in $filter"],
    ['createdAt ge 2026-01-31T10:30:15.Z', "400 Unexpected character '.' in $filter"],
    ['createdAt ge 2026-01-31 02:00', "400 Unexpected 'int' in $filter"],
    ['createdAt ge 2026-01-31+02:00', "400 Unexpected character '+' in $filter"],
    ['createdAt ge 2026-01-31-02:00', "400 Unexpected 'int' in $filter"],
    ['createdAt ge 2026-01-31T10:30+0200', "400 Unexpected character '+' in $filter"],
    ['createdAt ge 2026-01-31T10:30+02', "400 Unexpected character '+' in $filter"],
    ['createdAt ge 2026-01-31T10:30-05', "400 Unexpected 'int' in $filter"],
    ['createdAt ge 2026-01-31T10:30z', "400 Unexpected character 'z' in $filter"],
    ['createdAt ge 2026-01-31t10:30Z', "400 Unexpected character 't' in $filter"],
    ['createdAt ge 2026-01-31T10:30ZZ', "400 Unexpected character 'Z' in $filter"],
    ['createdAt ge 2026-01-31T10:30Z5', "400 Unexpected character '5' in $filter"],
    ['createdAt ge 2026-01-31T10:30+02:00:00', "400 Unexpected ':' in $filter"],
    ['createdAt ge 2026-1-31', "400 Cannot compare Edm.DateTimeOffset 'createdAt' with a int literal"],
    ['createdAt ge 2026-01-3', "400 Cannot compare Edm.DateTimeOffset 'createdAt' with a int literal"],
    ['createdAt ge 20260131', "400 Cannot compare Edm.DateTimeOffset 'createdAt' with a int literal"],
    ['createdAt ge 12026-01-31', "400 Cannot compare Edm.DateTimeOffset 'createdAt' with a int literal"],
    ['createdAt ge 2026-01-311', "400 Unexpected character '1' in $filter"],
    ['createdAt ge 2026-01-31-', "400 Unexpected character '-' in $filter"],
    ['createdAt ge -2026-01-31', "400 Cannot compare Edm.DateTimeOffset 'createdAt' with a int literal"],
    ['createdAt eq 2026-02-30', "400 '2026-02-30' is not a valid date or time"],
    ['createdAt eq 2026-13-01', "400 '2026-13-01' is not a valid date or time"],
    ['createdAt eq 2026-01-31T24:00:00Z', "400 '2026-01-31T24:00:00Z' is not a valid date or time"],
    ['createdAt eq 2026-01-31T10:60:00Z', "400 '2026-01-31T10:60:00Z' is not a valid date or time"],
    ['createdAt eq 2026-01-31T10:00:60.5+01:00', "400 '2026-01-31T10:00:60.5+01:00' is not a valid date or time"],
    ['createdAt eq 0001-01-01T00:00:00+05:00', "400 '0001-01-01T00:00:00+05:00' is out of range"],
    ['createdAt eq 9999-12-31T23:59:59-01:00', "400 '9999-12-31T23:59:59-01:00' is out of range"],
    // The last day ends in the year 10000, written as the database reads it (not `toISOString()`'s `+010000`).
    ['createdAt eq 9999-12-31', '{"kind":"cmp","op":"eq","prop":"createdAt","lit":{"type":"datetime","ts":"9999-12-31 00:00:00.000","dayEnd":"10000-01-01 00:00:00.000"}}'],
    ['createdAt ge 0001-01-01', '{"kind":"cmp","op":"ge","prop":"createdAt","lit":{"type":"datetime","ts":"0001-01-01 00:00:00.000","dayEnd":"0001-01-02 00:00:00.000"}}'],
    ['createdAt eq 0000-01-01', "400 '0000-01-01' is out of range"],
    ['createdAt eq 0000-00-00', "400 '0000-00-00' is not a valid date or time"],
    ['2026-01-31T10:30:15.5Z lt createdAt', '{"kind":"cmp","op":"gt","prop":"createdAt","lit":{"type":"datetime","ts":"2026-01-31 10:30:15.500"}}'],
    ['createdAt ge 2026-01-31T10:30:15.5Zand state eq 1', "400 Unexpected character 'a' in $filter"],
    ['createdAt ge 2026-01-31)', "400 Unexpected ')' in $filter"],
    ['createdAt ge (2026-01-31)', "400 Unexpected '(' in $filter"],
    ['year(createdAt) eq 2026-01-31', "400 Cannot compare Edm.Int32 'createdAt' with a datetime literal"],
    ['rating eq 007', '{"kind":"cmp","op":"eq","prop":"rating","lit":{"type":"int","value":7}}'],
    ['rating eq -3', '{"kind":"cmp","op":"eq","prop":"rating","lit":{"type":"int","value":-3}}'],
    ['rating eq 1e3', "400 Cannot compare Edm.Int32 'rating' with a double literal"],
    ['rating eq 1E+3', "400 Cannot compare Edm.Int32 'rating' with a double literal"],
    ['rating eq 1e-3', "400 Cannot compare Edm.Int32 'rating' with a double literal"],
    ['rating eq 1.5', "400 Cannot compare Edm.Int32 'rating' with a double literal"],
    ['rating eq 1.', "400 Unexpected character '.' in $filter"],
    ['rating eq .5', "400 Unexpected character '.' in $filter"],
    ['rating eq 1.5.2', "400 Unexpected character '.' in $filter"],
    ['rating eq 1e', "400 Unexpected character 'e' in $filter"],
    ['rating eq 1e+', "400 Unexpected character 'e' in $filter"],
    ['rating eq 1_000', "400 Unexpected character '_' in $filter"],
    ['rating eq 1x', "400 Unexpected character 'x' in $filter"],
    ['rating eq 1é', "400 Unexpected character 'é' in $filter"],
    ['rating eq 99999999999999999999', "400 '99999999999999999999' is out of range"],
    ['rating eq 9007199254740993', "400 '9007199254740993' is out of range"],
    ['rating eq 9007199254740991', "400 '9007199254740991' does not fit Edm.Int32 'rating'"],
    ['rating eq 1e400', "400 '1e400' is out of range"],
    ['rating eq -', "400 Unexpected character '-' in $filter"],
    ['rating eq --1', "400 Unexpected character '-' in $filter"],
    ['rating eq -a', "400 Unexpected character '-' in $filter"],
    ['rating eq - 1', "400 Unexpected character '-' in $filter"],
    ['rating eq +1', "400 Unexpected character '+' in $filter"],
    ['rating eq ٣', "400 Unexpected character '٣' in $filter"],
    ['rating eq １', "400 Unexpected character '１' in $filter"],
    ['rating eq 1٣', "400 Unexpected character '٣' in $filter"],
    [`rating eq ${'9'.repeat(1900)}`, `400 '${'9'.repeat(1900)}' is out of range`],
    ['rating eq 100000000000000000000', "400 '100000000000000000000' is out of range"],
    ['rating eq 5-3', "400 Unexpected 'int' in $filter"],
    ['rating eq 5 -3', "400 Unexpected 'int' in $filter"],
    ["title_x eq 'a'", "400 Unknown property 'title_x' on Conversations"],
    ["_title eq 'a'", "400 Unknown property '_title' on Conversations"],
    ["title9 eq 'a'", "400 Unknown property 'title9' on Conversations"],
    ["tïtle eq 'a'", "400 Unexpected character 'ï' in $filter"],
    ["title\u017f eq 'a'", "400 Unexpected character '\u017f' in $filter"],
    ["title\u212a eq 'a'", "400 Unexpected character '\u212a' in $filter"],
    ["ｔitle eq 'a'", "400 Unexpected character 'ｔ' in $filter"],
    ["title$ eq 'a'", "400 Unexpected character '$' in $filter"],
    ["title.x eq 'a'", "400 Unexpected character '.' in $filter"],
    ["9title eq 'a'", "400 Unexpected character 't' in $filter"],
    ["__proto__ eq 'a'", "400 Unknown property '__proto__' on Conversations"],
    ["hidden eq 'a'", "400 Property 'hidden' cannot be used in $filter"],
    ['titleeq 5', "400 Unknown property 'titleeq' on Conversations"],
    ["title eq '", '400 Unterminated string literal in $filter'],
    ["title eq 'a''", '400 Unterminated string literal in $filter'],
    ["title eq '''", '400 Unterminated string literal in $filter'],
    ["title eq ''''", '{"kind":"cmp","op":"eq","prop":"title","lit":{"type":"string","value":"\'"}}'],
    ["title eq 'tab\there'", '{"kind":"cmp","op":"eq","prop":"title","lit":{"type":"string","value":"tab\\there"}}'],
    ["title eq 'line\nbreak'", '{"kind":"cmp","op":"eq","prop":"title","lit":{"type":"string","value":"line\\nbreak"}}'],
    ["title eq '😀 ü'", '{"kind":"cmp","op":"eq","prop":"title","lit":{"type":"string","value":"😀 ü"}}'],
    [`title eq ${"'".repeat(1802)}`, `{"kind":"cmp","op":"eq","prop":"title","lit":{"type":"string","value":"${"'".repeat(900)}"}}`],
    ["title eq 'a'b'", '400 Unterminated string literal in $filter'],
    // A NUL in a string literal: Postgres refuses it in a text parameter.
    ["title eq 'a\u0000b'", '400 A string literal in $filter must not contain a NUL character'],
    ["title eq '\u0000'", '400 A string literal in $filter must not contain a NUL character'],
    ["contains(title,'a\u0000')", '400 A string literal in $filter must not contain a NUL character'],
    ["tags/any(t: t eq '\u0000')", '400 A string literal in $filter must not contain a NUL character'],
    ["title eq 'a\u0000b", '400 Unterminated string literal in $filter'],
    ["title eq 'ok' and nope eq 'a\u0000'", '400 A string literal in $filter must not contain a NUL character'],
    ["title\u0000 eq 'a'", "400 Unexpected character '\u0000' in $filter"],
    ["title eq 'a' 'b'", "400 Unexpected 'b' in $filter"],
    ['title eq 😀', "400 Unexpected character '\ud83d' in $filter"],
    ["title\neq 'a'", "400 Unexpected character '\n' in $filter"],
    ["title\u00a0eq 'a'", "400 Unexpected character '\u00a0' in $filter"],
    ["title\teq\t'a'", '{"kind":"cmp","op":"eq","prop":"title","lit":{"type":"string","value":"a"}}'],
    ["  title   eq   'a'  ", '{"kind":"cmp","op":"eq","prop":"title","lit":{"type":"string","value":"a"}}'],
    ["title eq 'a' ; x", "400 Unexpected character ';' in $filter"],
    ['title eq "a"', '400 Unexpected character \'"\' in $filter'],
    ['title eq `a`', "400 Unexpected character '`' in $filter"],
    ['title eq [1]', "400 Unexpected character '[' in $filter"],
    ['title eq {1}', "400 Unexpected character '{' in $filter"],
    ['title eq a/b', "400 Unknown property 'a' on Conversations"],
    ["title eq 'a' or", '400 Unexpected end of expression in $filter'],
    ["title : 'a'", "400 Expected a comparison (eq, ne, gt, ge, lt, le) but found ':' in $filter"],
    ["title , 'a'", "400 Expected a comparison (eq, ne, gt, ge, lt, le) but found ',' in $filter"],
    ['title gt null', "400 null can only be compared with eq or ne (property 'title')"],
    ['null gt title', "400 null can only be compared with eq or ne (property 'title')"],
    ['title eq 5', "400 Cannot compare Edm.String 'title' with a int literal"],
    ['title eq 5.5', "400 Cannot compare Edm.String 'title' with a double literal"],
    ['title eq true', "400 Cannot compare Edm.String 'title' with a boolean literal"],
    ['title eq 2026-01-31', "400 Cannot compare Edm.String 'title' with a datetime literal"],
    ["conversationNumber eq 'x'", "400 Cannot compare Edm.Int32 'conversationNumber' with a string literal"],
    ['conversationNumber eq 2147483647', '{"kind":"cmp","op":"eq","prop":"conversationNumber","lit":{"type":"int","value":2147483647}}'],
    ['conversationNumber eq 2147483648', "400 '2147483648' does not fit Edm.Int32 'conversationNumber'"],
    ['conversationNumber eq -2147483647', '{"kind":"cmp","op":"eq","prop":"conversationNumber","lit":{"type":"int","value":-2147483647}}'],
    ['conversationNumber eq -2147483648', "400 '-2147483648' does not fit Edm.Int32 'conversationNumber'"],
    ['conversationNumber eq 1.5', "400 Cannot compare Edm.Int32 'conversationNumber' with a double literal"],
    ['conversationNumber eq true', "400 Cannot compare Edm.Int32 'conversationNumber' with a boolean literal"],
    ['conversationNumber eq null', '{"kind":"cmp","op":"eq","prop":"conversationNumber","lit":{"type":"null"}}'],
    ['conversationNumber gt 2147483648', "400 '2147483648' does not fit Edm.Int32 'conversationNumber'"],
    ['2147483648 lt conversationNumber', "400 '2147483648' does not fit Edm.Int32 'conversationNumber'"],
    ['isMajorIncident gt true', "400 Booleans can only be compared with eq or ne (property 'isMajorIncident')"],
    ['isMajorIncident ne true', '{"kind":"cmp","op":"ne","prop":"isMajorIncident","lit":{"type":"boolean","value":true}}'],
    ["isMajorIncident eq 'true'", "400 Cannot compare Edm.Boolean 'isMajorIncident' with a string literal"],
    ["isMajorIncident gt 'true'", "400 Cannot compare Edm.Boolean 'isMajorIncident' with a string literal"],
    ['isMajorIncident eq 1', "400 Cannot compare Edm.Boolean 'isMajorIncident' with a int literal"],
    ['isMajorIncident gt null', "400 null can only be compared with eq or ne (property 'isMajorIncident')"],
    ['createdAt eq 5', "400 Cannot compare Edm.DateTimeOffset 'createdAt' with a int literal"],
    ["createdAt eq 'yesterday'", "400 Cannot compare Edm.DateTimeOffset 'createdAt' with a string literal"],
    ['createdAt eq true', "400 Cannot compare Edm.DateTimeOffset 'createdAt' with a boolean literal"],
    ["tags eq 'vip'", "400 Property 'tags' is a collection: use tags/any(t: t eq 'value')"],
    ['tags eq 5', "400 Property 'tags' is a collection: use tags/any(t: t eq 'value')"],
    ['tags eq null', '{"kind":"cmp","op":"eq","prop":"tags","lit":{"type":"null"}}'],
    ['tags gt null', "400 null can only be compared with eq or ne (property 'tags')"],
    ['tags ne null', '{"kind":"cmp","op":"ne","prop":"tags","lit":{"type":"null"}}'],
    ['year(createdAt) eq 2147483648', "400 '2147483648' does not fit Edm.Int32 'createdAt'"],
    ["year(createdAt) eq 'x'", "400 Cannot compare Edm.Int32 'createdAt' with a string literal"],
    ['year(createdAt) eq 1.5', "400 Cannot compare Edm.Int32 'createdAt' with a double literal"],
    ['year(createdAt) eq null', '{"kind":"cmp","op":"eq","prop":"createdAt","fn":"year","lit":{"type":"null"}}'],
    ['year(createdAt) gt null', "400 null can only be compared with eq or ne (property 'createdAt')"],
    ['big eq 5', '{"kind":"cmp","op":"eq","prop":"big","lit":{"type":"int","value":5}}'],
    ['big eq 9007199254740991', '{"kind":"cmp","op":"eq","prop":"big","lit":{"type":"int","value":9007199254740991}}'],
    ['big eq -5', '{"kind":"cmp","op":"eq","prop":"big","lit":{"type":"int","value":-5}}'],
    ['big eq 1.5', "400 Cannot compare Edm.Int64 'big' with a double literal"],
    ["big eq 'x'", "400 Cannot compare Edm.Int64 'big' with a string literal"],
    ['big eq true', "400 Cannot compare Edm.Int64 'big' with a boolean literal"],
    ['big gt null', "400 null can only be compared with eq or ne (property 'big')"],
    ['big eq null', '{"kind":"cmp","op":"eq","prop":"big","lit":{"type":"null"}}'],
    ['ratio eq 5', '{"kind":"cmp","op":"eq","prop":"ratio","lit":{"type":"int","value":5}}'],
    ['ratio eq 1.5', '{"kind":"cmp","op":"eq","prop":"ratio","lit":{"type":"double","value":1.5}}'],
    ['ratio eq 1e3', '{"kind":"cmp","op":"eq","prop":"ratio","lit":{"type":"double","value":1000}}'],
    ['ratio eq -1.5e-3', '{"kind":"cmp","op":"eq","prop":"ratio","lit":{"type":"double","value":-0.0015}}'],
    ["ratio eq 'x'", "400 Cannot compare Edm.Double 'ratio' with a string literal"],
    ['ratio eq true', "400 Cannot compare Edm.Double 'ratio' with a boolean literal"],
    ['ratio eq 2026-01-31', "400 Cannot compare Edm.Double 'ratio' with a datetime literal"],
    ['ratio lt null', "400 null can only be compared with eq or ne (property 'ratio')"],
  ])('reads %j', (text, expected) => {
    expect(outcome(text)).toBe(expected);
  });
});

describe('SQL', () => {
  it('binds every literal and casts it', () => {
    const { sql, params } = render("state eq 'open' and rating ge 3 and createdAt lt 2026-01-31T00:00:00Z and isMajorIncident eq true");
    expect(params).toEqual(['open', 3, '2026-01-31 00:00:00.000', true]);
    expect(sql).toContain('::text');
    expect(sql).toContain('::int');
    expect(sql).toContain('::timestamp');
    expect(sql).toContain('::boolean');
    for (const text of ['open', '2026', 'true']) expect(sql).not.toContain(text);
  });

  it('uses IS NULL, IS NOT NULL and IS DISTINCT FROM', () => {
    expect(render('title eq null').sql).toContain('IS NULL');
    expect(render('title ne null').sql).toContain('IS NOT NULL');
    expect(render("title ne 'x'").sql).toContain('IS DISTINCT FROM');
    expect(render("title eq 'x'").sql).toContain('COALESCE(');
  });

  it('turns a bare date into a day for eq and ne, a midnight for the rest', () => {
    const eq = render('createdAt eq 2026-01-31');
    expect(eq.params).toEqual(['2026-01-31 00:00:00.000', '2026-02-01 00:00:00.000']);
    expect(render('createdAt ne 2026-01-31').sql).toContain('NOT');
    expect(render('createdAt ge 2026-01-31').params).toEqual(['2026-01-31 00:00:00.000']);
  });

  it('escapes % _ and the backslash in LIKE patterns', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    const { sql, params } = render("contains(title,'50%_')");
    expect(params).toEqual(['%50\\%\\_%']);
    expect(sql).toContain('LIKE');
    expect(sql).toContain("ESCAPE '\\'");
    expect(render("startswith(title,'a%')").params).toEqual(['a\\%%']);
    expect(render("endswith(title,'_a')").params).toEqual(['%\\_a']);
  });

  it('compiles year, month and day to extract() and any() to a jsonb containment', () => {
    expect(render('year(createdAt) eq 2026').sql).toContain('extract(year from');
    expect(render('month(createdAt) eq 1').sql).toContain('extract(month from');
    expect(render('day(createdAt) eq 1').sql).toContain('extract(day from');
    const any = render("tags/any(t: t eq 'vip')");
    expect(any.sql).toContain('@> jsonb_build_array(');
    expect(any.params).toEqual(['vip']);
  });

  it('reads a timestamptz column as UTC', () => {
    const agents = findEntitySet('Agents')!;
    const { sql } = new PgDialect().sqlToQuery(filterToSql(parseFilter('createdAt ge 2026-01-01T00:00:00Z', agents), agents));
    expect(sql).toContain("AT TIME ZONE 'UTC'");
  });

  it('takes identifiers and expressions from the catalogue only', () => {
    const messages = findEntitySet('Messages')!;
    const { sql, params } = new PgDialect().sqlToQuery(filterToSql(parseFilter("eventType eq 'closed'", messages), messages));
    expect(sql).toContain("(metadata->>'eventType')");
    expect(params).toEqual(['closed']);
    expect(render('state eq null').sql).toContain('"desk_conversations"."state"');
  });

  it('cannot be reached by an injection through a property name', () => {
    for (const name of [
      'id; DROP TABLE desk_conversations',
      'id) OR (1=1',
      '"id"',
      'id--',
      'state/**/eq',
      "' or 1=1 --",
      'id OR 1',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(failure(`${name} eq 'x'`).status, name).toBeGreaterThanOrEqual(400);
    }
  });

  it('cannot be reached by an injection through a literal', () => {
    const attacks = [
      "x'; DROP TABLE desk_conversations; --",
      "' OR '1'='1",
      "\\'; DELETE FROM desk_conversations; --",
      "' OR title LIKE '",
      '${1+1}',
      '$1::text) OR (1=1',
    ];
    for (const attack of attacks) {
      const quoted = `'${attack.replace(/'/g, "''")}'`;
      for (const text of [`state eq ${quoted}`, `contains(title,${quoted})`, `tags/any(t: t eq ${quoted})`, `title ne ${quoted} and state eq 'a'`]) {
        const { sql, params } = render(text);
        expect(sql, text).not.toContain('DROP');
        expect(sql, text).not.toContain('DELETE');
        expect(sql, text).not.toContain('1=1');
        expect(sql, text).not.toContain('1+1');
        expect(sql, text).not.toContain('OR title');
        expect(params.map(String).some((p) => p.includes(attack) || p.includes(escapeLike(attack))), text).toBe(true);
      }
    }
    // a NUL never becomes a parameter: Postgres would refuse the statement
    for (const text of ["state eq '\u0000'", "contains(title,'a\u0000')", "tags/any(t: t eq '\u0000b')"]) {
      rejects(text);
    }
    // numbers are numbers: nothing else gets through the tokenizer
    for (const text of ['rating eq 1; DROP TABLE x', 'rating eq 1 OR 1=1', 'rating eq (1)', 'rating eq 1/**/']) {
      rejects(text);
    }
  });

  it.each<[string, string, unknown[]]>([
    ["state eq 'a' and channel eq 'b'", '(COALESCE("desk_conversations"."state" = $1::text, false) AND COALESCE("desk_conversations"."channel" = $2::text, false))', ["a","b"]],
    ["state eq 'a' or channel eq 'b' or priority eq 'c'", '(COALESCE("desk_conversations"."state" = $1::text, false) OR COALESCE("desk_conversations"."channel" = $2::text, false) OR COALESCE("desk_conversations"."priority" = $3::text, false))', ["a","b","c"]],
    ["state eq 'a' and (channel eq 'b' or priority eq 'c') and not rating gt 3", '(COALESCE("desk_conversations"."state" = $1::text, false) AND (COALESCE("desk_conversations"."channel" = $2::text, false) OR COALESCE("desk_conversations"."priority" = $3::text, false)) AND (NOT COALESCE("desk_conversations"."rating" > $4::int, false)))', ["a","b","c",3]],
    ["not (state eq 'a' and channel eq 'b')", '(NOT (COALESCE("desk_conversations"."state" = $1::text, false) AND COALESCE("desk_conversations"."channel" = $2::text, false)))', ["a","b"]],
    ["contains(title,'50%_')", 'COALESCE("desk_conversations"."title" LIKE $1::text ESCAPE \'\\\', false)', ["%50\\%\\_%"]],
    ["startswith(title,'a\\')", 'COALESCE("desk_conversations"."title" LIKE $1::text ESCAPE \'\\\', false)', ["a\\\\%"]],
    ["endswith(title,'_a')", 'COALESCE("desk_conversations"."title" LIKE $1::text ESCAPE \'\\\', false)', ["%\\_a"]],
    ["contains(title,'')", 'COALESCE("desk_conversations"."title" LIKE $1::text ESCAPE \'\\\', false)', ["%%"]],
    ["tags/any(t: t eq 'vip')", 'COALESCE("desk_conversations"."tags" @> jsonb_build_array($1::text), false)', ["vip"]],
    ['createdAt eq 2026-01-31', 'COALESCE("desk_conversations"."created_at" >= $1::timestamp AND "desk_conversations"."created_at" < $2::timestamp, false)', ["2026-01-31 00:00:00.000","2026-02-01 00:00:00.000"]],
    ['createdAt ne 2026-01-31', 'NOT COALESCE("desk_conversations"."created_at" >= $1::timestamp AND "desk_conversations"."created_at" < $2::timestamp, false)', ["2026-01-31 00:00:00.000","2026-02-01 00:00:00.000"]],
    ['createdAt gt 2026-01-31', 'COALESCE("desk_conversations"."created_at" > $1::timestamp, false)', ["2026-01-31 00:00:00.000"]],
    ['createdAt eq 2026-01-31T00:00:00Z', 'COALESCE("desk_conversations"."created_at" = $1::timestamp, false)', ["2026-01-31 00:00:00.000"]],
    ['year(createdAt) ne 2026', 'extract(year from "desk_conversations"."created_at")::int IS DISTINCT FROM $1::int', [2026]],
    ['month(createdAt) le 6', 'COALESCE(extract(month from "desk_conversations"."created_at")::int <= $1::int, false)', [6]],
    ['title eq null', '"desk_conversations"."title" IS NULL', []],
    ['title ne null', '"desk_conversations"."title" IS NOT NULL', []],
    ['big eq 5', 'COALESCE("desk_conversations"."big" = $1::bigint, false)', [5]],
    ['ratio ge 5', 'COALESCE("desk_conversations"."ratio" >= $1::float8, false)', [5]],
    ['ratio ge 1.5', 'COALESCE("desk_conversations"."ratio" >= $1::float8, false)', [1.5]],
    ['isMajorIncident ne false', '"desk_conversations"."is_major_incident" IS DISTINCT FROM $1::boolean', [false]],
  ])('compiles %j', (text, sql, params) => {
    const query = new PgDialect().sqlToQuery(filterToSql(parseFilter(text, typed), typed));
    expect(query.sql).toBe(sql);
    expect(query.params).toEqual(params);
  });

  it('holds a placeholder for every value', () => {
    const { sql, params } = render("state eq 'a' and (rating gt 1 or contains(title,'b')) and tags/any(t: t eq 'c')");
    expect(sql.match(/\$\d+/g) ?? []).toHaveLength(params.length);
  });
});
