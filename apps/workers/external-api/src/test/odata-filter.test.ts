/**
 * `$filter` of the OData feed: the parser (grammar, precedence, quoting, dates,
 * functions, `any`, type checks, limits) and the SQL it compiles to. No
 * database: the SQL is rendered and its text and bound parameters are checked,
 * above all that nothing from the request reaches the text.
 */

import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { findEntitySet } from '../routes/v1/odata/catalog';
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
      rejects(`createdAt eq ${text}`);
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
    rejects("tolower(title) eq 'a'", 501);
    rejects('length(title) gt 3', 501);
    rejects("substringof('a', title)", 501);
    rejects("concat(title,'a') eq 'b'", 501);
    rejects("cast(title, 'Edm.Int32') eq 1", 501);
    rejects("nope eq 'a'");
    rejects("Title eq 'a'");
    rejects("title eq 'a' and nope eq 1");
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
    rejects("'a' eq 'b'");
    rejects('title eq state');
    rejects('1 eq 1');
    rejects("contains(title,'a') eq true");
    rejects('isMajorIncident');
    rejects('true');
    rejects("'x'");
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
      rejects(text);
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
      '\u0000',
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
    // numbers are numbers: nothing else gets through the tokenizer
    for (const text of ['rating eq 1; DROP TABLE x', 'rating eq 1 OR 1=1', 'rating eq (1)', 'rating eq 1/**/']) {
      rejects(text);
    }
  });

  it('holds a placeholder for every value', () => {
    const { sql, params } = render("state eq 'a' and (rating gt 1 or contains(title,'b')) and tags/any(t: t eq 'c')");
    expect((sql.match(/\$\d+/g) ?? []).length).toBe(params.length);
  });
});
