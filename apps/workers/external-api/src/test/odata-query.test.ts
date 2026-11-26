/**
 * Query options of the OData feed, the parts that need no database: reading
 * `$orderby`, which mistake a request is refused for first, skiptokens, and
 * the statements a page, a count and a single entity run (a stand-in for the
 * database records them, rendered with their bound parameters).
 */

import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { findEntitySet } from '@weldsuite/desk-domain/odata-catalog';
import { ODataError } from '../routes/v1/odata/errors';
import { parseFilter } from '../routes/v1/odata/filter';
import {
  countRows,
  decodeSkipToken,
  encodeSkipToken,
  fetchEntity,
  fetchPage,
  parseQueryOptions,
  type PageResult,
  type QueryOptions,
  type SkipToken,
  type Surface,
} from '../routes/v1/odata/query';
import type { Database } from '../db';

const conversations = findEntitySet('Conversations')!;

/** What a call answers: its value as JSON, or `<status> <message>` when it refuses. */
function outcome(run: () => unknown): string {
  try {
    return JSON.stringify(run());
  } catch (error) {
    if (error instanceof ODataError) return `${error.status} ${error.message}`;
    throw error;
  }
}

const orderOf = (options: QueryOptions): string[] =>
  options.orderby.map((term) => (term.desc ? `${term.prop.name} desc` : term.prop.name));

/** The options with properties by name, in the order they were set. */
const summaryOf = (options: QueryOptions) => ({
  ...options,
  select: options.select?.map((prop) => prop.name) ?? null,
  orderby: orderOf(options),
  filter: options.filter ? 'yes' : undefined,
});

type Statement = [sql: string, params: unknown[]];

/** A database that runs nothing and keeps what it was asked. */
function recorder(): { db: Database; statements: Statement[] } {
  const dialect = new PgDialect();
  const statements: Statement[] = [];
  const db = {
    execute: async (statement: SQL) => {
      const { sql, params } = dialect.sqlToQuery(statement);
      statements.push([sql, params]);
      return [];
    },
  } as unknown as Database;
  return { db, statements };
}

describe('$orderby', () => {
  it.each<[string, string]>([
    ['id', '["id"]'],
    ['id asc', '["id"]'],
    ['id desc', '["id desc"]'],
    ['id   desc', '["id desc"]'],
    ['id\tdesc', '["id desc"]'],
    ['id\ndesc', '["id desc"]'],
    ['id\u00a0desc', '["id desc"]'],
    [' id ', '["id"]'],
    ['id DESC', "400 Invalid $orderby term 'id DESC'"],
    ['id Desc', "400 Invalid $orderby term 'id Desc'"],
    ['id descx', "400 Invalid $orderby term 'id descx'"],
    ['id desc desc', "400 Invalid $orderby term 'id desc desc'"],
    ['id asc desc', "400 Invalid $orderby term 'id asc desc'"],
    ['id,', "400 Invalid $orderby term ''"],
    [',id', "400 Invalid $orderby term ''"],
    ['', "400 Invalid $orderby term ''"],
    [' ', "400 Invalid $orderby term ''"],
    ['idé', "400 Invalid $orderby term 'idé'"],
    ['i-d', "400 Invalid $orderby term 'i-d'"],
    ['a/b', '501 $orderby supports property names only'],
    ['f(x)', '501 $orderby supports property names only'],
    ['id (', '501 $orderby supports property names only'],
    ['_x', "400 Unknown property '_x' in $orderby"],
    ['9id', "400 Invalid $orderby term '9id'"],
    ['id9', "400 Unknown property 'id9' in $orderby"],
    ['\u017fid', "400 Invalid $orderby term '\u017fid'"],
    ['id\u212a', "400 Invalid $orderby term 'id\u212a'"],
    ['createdAt desc, id', '["createdAt desc","id"]'],
    ['state , conversationNumber   desc ,id asc', '["state","conversationNumber desc","id"]'],
    ['a,b,c,d,e,f', '400 $orderby has more than 5 terms'],
    ['tags', "400 Property 'tags' cannot be used in $orderby"],
    ['nope desc', "400 Unknown property 'nope' in $orderby"],
    [`id${' '.repeat(3000)}desc`, '["id desc"]'],
    [`id${' '.repeat(3000)}x`, `400 Invalid $orderby term 'id${' '.repeat(3000)}x'`],
    [`${'a'.repeat(3000)}`, `400 Unknown property '${'a'.repeat(3000)}' in $orderby`],
    [`${'a'.repeat(3000)} desc x`, `400 Invalid $orderby term '${'a'.repeat(3000)} desc x'`],
  ])('reads %j', (raw, expected) => {
    const read = () => orderOf(parseQueryOptions(new URLSearchParams({ $orderby: raw }), conversations, 'collection'));
    expect(outcome(read)).toBe(expected);
  });
});

describe('query options', () => {
  // A request with several mistakes is refused for the first one in the order the options are read, not the order they were sent in.
  it.each<[string, Surface, string]>([
    ['', 'collection', '{"select":null,"orderby":[],"count":false}'],
    ['custom=1&$top=5', 'collection', '{"select":null,"orderby":[],"count":false,"top":5}'],
    ['$top=5&$skip=2&$count=true&$select=id,title&$orderby=createdAt desc', 'collection', '{"select":["id","title"],"orderby":["createdAt desc"],"count":true,"top":5,"skip":2}'],
    ['$top=abc&$skip=x', 'collection', '400 $top must be a non-negative integer'],
    ['$skip=x&$top=abc', 'collection', '400 $top must be a non-negative integer'],
    ['$top=', 'collection', '400 $top must be a non-negative integer'],
    ['$top=1234567890', 'collection', '400 $top must be a non-negative integer'],
    ['$top=123456789', 'collection', '{"select":null,"orderby":[],"count":false,"top":123456789}'],
    ['$top=٣', 'collection', '400 $top must be a non-negative integer'],
    ['$expand=x&$nope=1', 'collection', '501 $expand is not supported'],
    ['$nope=1&$expand=x', 'collection', "400 Unknown query option '$nope'"],
    ['$EXPAND=x', 'collection', '501 $EXPAND is not supported'],
    ['$Top=1', 'collection', "400 Unknown query option '$Top'"],
    ['$top=1&$top=2', 'collection', '400 $top is given more than once'],
    ['$top=1&$nope=2&$top=2', 'collection', "400 Unknown query option '$nope'"],
    ['$top=1', 'count', '400 $top is not allowed here'],
    ['$top=1', 'entity', '400 $top is not allowed here'],
    ['$filter=state eq 1&$top=1', 'count', '400 $top is not allowed here'],
    ['$select=id&$filter=x', 'entity', '400 $filter is not allowed here'],
    ['$format=xml', 'collection', '415 $format=xml is not supported, only json'],
    ['$format=xml&$top=abc', 'collection', '415 $format=xml is not supported, only json'],
    ['$top=abc&$format=xml', 'collection', '415 $format=xml is not supported, only json'],
    ['$format=JSON;odata.metadata=none', 'collection', '{"select":null,"orderby":[],"count":false}'],
    ['$format= json ', 'collection', '{"select":null,"orderby":[],"count":false}'],
    ['$format=application/json;x', 'collection', '{"select":null,"orderby":[],"count":false}'],
    ['$format=application/jsonx', 'collection', '415 $format=application/jsonx is not supported, only json'],
    ['$format=json;a\nb', 'collection', '415 $format=json;a\nb is not supported, only json'],
    ['$format=', 'collection', '415 $format= is not supported, only json'],
    ['$count=yes', 'collection', '400 $count must be true or false'],
    ['$count=TRUE', 'collection', '400 $count must be true or false'],
    ['$count=false', 'collection', '{"select":null,"orderby":[],"count":false}'],
    ['$count=yes&$filter=nope eq 1', 'collection', "400 Unknown property 'nope' on Conversations"],
    ['$filter=nope eq 1&$count=yes', 'collection', "400 Unknown property 'nope' on Conversations"],
    ['$orderby=nope&$select=nope', 'collection', "400 Unknown property 'nope' in $select"],
    ['$select=nope&$filter=nope eq 1&$skiptoken=!!', 'collection', '400 Invalid $skiptoken'],
    ['$skiptoken=!!&$select=nope', 'collection', '400 Invalid $skiptoken'],
    ['$select=*', 'collection', '{"select":null,"orderby":[],"count":false}'],
    ['$select=id,,title', 'collection', '400 $select has an empty item'],
    ['$select=a/b', 'collection', "501 $select paths are not supported ('a/b')"],
    ['$select=a.b', 'collection', "501 $select paths are not supported ('a.b')"],
    ['$skiptoken=eyJvIjo1fQ', 'collection', '400 This $skiptoken does not belong to this query'],
    ['$skiptoken=eyJvIjo1fQ&$orderby=id', 'collection', '{"select":null,"orderby":["id"],"count":false,"skiptoken":{"o":5}}'],
    ['$skiptoken=eyJrIjoiYSJ9', 'collection', '{"select":null,"orderby":[],"count":false,"skiptoken":{"k":"a"}}'],
    ['$skiptoken=eyJrIjoiYSJ9&$orderby=id', 'collection', '400 This $skiptoken does not belong to this query'],
    ['$skiptoken=eyJrIjoiYSJ9&$orderby=id&$count=maybe', 'collection', '400 $count must be true or false'],
  ])('reads %j on a %s', (query, surface, expected) => {
    const read = () => summaryOf(parseQueryOptions(new URLSearchParams(query), conversations, surface));
    expect(outcome(read)).toBe(expected);
  });
});

describe('skiptokens', () => {
  it.each<[SkipToken, string]>([
    [{"k":"msg_01000"}, 'eyJrIjoibXNnXzAxMDAwIn0'],
    [{"k":""}, 'eyJrIjoiIn0'],
    [{"k":"a"}, 'eyJrIjoiYSJ9'],
    [{"k":"ab"}, 'eyJrIjoiYWIifQ'],
    [{"k":"abc"}, 'eyJrIjoiYWJjIn0'],
    [{"k":"??>>~~"}, 'eyJrIjoiPz8-Pn5-In0'],
    [{"k":"ÿÿÿ"}, 'eyJrIjoiw7_Dv8O_In0'],
    [{"k":"日本語 😀"}, 'eyJrIjoi5pel5pys6KqeIPCfmIAifQ'],
    [{"k":"="}, 'eyJrIjoiPSJ9'],
    [{ k: 'x'.repeat(1000) }, `eyJrIjoi${'eHh4'.repeat(333)}eCJ9`],
    [{"o":0}, 'eyJvIjowfQ'],
    [{"o":1000}, 'eyJvIjoxMDAwfQ'],
    // The largest offset the database's `OFFSET … ::int` takes.
    [{"o":2147483647}, 'eyJvIjoyMTQ3NDgzNjQ3fQ'],
  ])('writes %j as base64url without padding, and reads it back', (token, encoded) => {
    expect(encodeSkipToken(token)).toBe(encoded);
    expect(decodeSkipToken(encoded)).toEqual(token);
  });

  it.each<[string, string]>([
    ['', '400 Invalid $skiptoken'],
    ['=', '400 Invalid $skiptoken'],
    ['====', '400 Invalid $skiptoken'],
    ['garbage!!', '400 Invalid $skiptoken'],
    ['e30', '400 Invalid $skiptoken'],
    ['eyJrIjoxfQ', '400 Invalid $skiptoken'],
    ['eyJvIjotMX0', '400 Invalid $skiptoken'],
    ['eyJvIjoxLjV9', '400 Invalid $skiptoken'],
    ['eyJrIjoiYSIsIm8iOjF9', '400 Invalid $skiptoken'],
    // An offset `OFFSET … ::int` would refuse: {"o":2147483648}, {"o":123456789012}, {"o":1e10}, {"o":9007199254740993}.
    ['eyJvIjoyMTQ3NDgzNjQ4fQ', '400 Invalid $skiptoken'],
    ['eyJvIjoxMjM0NTY3ODkwMTJ9', '400 Invalid $skiptoken'],
    ['eyJvIjoxZTEwfQ', '400 Invalid $skiptoken'],
    ['eyJvIjo5MDA3MTk5MjU0NzQwOTkzfQ', '400 Invalid $skiptoken'],
    // An offset that is not a number, a key that is not a string: {"o":"5"}, {"k":null}, {"k":["a"]}.
    ['eyJvIjoiNSJ9', '400 Invalid $skiptoken'],
    ['eyJrIjpudWxsfQ', '400 Invalid $skiptoken'],
    ['eyJrIjpbImEiXX0', '400 Invalid $skiptoken'],
    // A NUL in the key ({"k":"a\u0000b"}): Postgres refuses it in a text parameter.
    ['eyJrIjoiYVx1MDAwMGIifQ', '400 Invalid $skiptoken'],
    ['eyJvIjoyMTQ3NDgzNjQ3fQ', '{"o":2147483647}'],
    ['bnVsbA', '400 Invalid $skiptoken'],
    ['eyJrIjoiYSJ9==', '400 Invalid $skiptoken'],
    ['eyJrIjoiYSJ9\n', '{"k":"a"}'],
    [' eyJrIjoiYSJ9 ', '{"k":"a"}'],
  ])('reads %j', (raw, expected) => {
    expect(outcome(() => decodeSkipToken(raw))).toBe(expected);
  });
});

describe('statements', () => {
  interface PageCase {
    label: string;
    set: string;
    query: string;
    statements: Statement[];
    result: PageResult;
  }

  it.each<PageCase>([
    {
      label: 'plain',
      set: 'Teams',
      query: '$select=id',
      statements: [
        ['SELECT "helpdesk_departments"."id" AS "id", "helpdesk_departments"."id" AS "__key" FROM "helpdesk_departments" WHERE "helpdesk_departments"."deleted_at" IS NULL ORDER BY "helpdesk_departments"."id" ASC LIMIT $1::int OFFSET $2::int', [1001,0]],
      ],
      result: { rows: [], next: null, remainingTop: null, total: null },
    },
    {
      label: 'everything',
      set: 'Teams',
      query: "$select=id,name&$orderby=name desc,createdAt&$filter=isActive eq true and contains(name,'a')&$count=true&$top=5&$skip=3",
      statements: [
        ['SELECT "helpdesk_departments"."id" AS "id", "helpdesk_departments"."name" AS "name", "helpdesk_departments"."id" AS "__key" FROM "helpdesk_departments" WHERE "helpdesk_departments"."deleted_at" IS NULL AND (COALESCE("helpdesk_departments"."is_active" = $1::boolean, false) AND COALESCE("helpdesk_departments"."name" LIKE $2::text ESCAPE \'\\\', false)) ORDER BY "helpdesk_departments"."name" DESC NULLS LAST, "helpdesk_departments"."created_at" ASC NULLS FIRST, "helpdesk_departments"."id" ASC LIMIT $3::int OFFSET $4::int', [true,"%a%",5,3]],
        ['SELECT count(*)::text AS n FROM "helpdesk_departments" WHERE "helpdesk_departments"."deleted_at" IS NULL AND (COALESCE("helpdesk_departments"."is_active" = $1::boolean, false) AND COALESCE("helpdesk_departments"."name" LIKE $2::text ESCAPE \'\\\', false))', [true,"%a%"]],
      ],
      result: { rows: [], next: null, remainingTop: 5, total: 0 },
    },
    {
      label: 'keyset',
      set: 'Messages',
      query: '$select=id&$skiptoken=eyJrIjoibXNnXzAxMDAwIn0',
      statements: [
        ['SELECT "desk_messages"."id" AS "id", "desk_messages"."id" AS "__key" FROM "desk_messages" WHERE "desk_messages"."id" > $1::text ORDER BY "desk_messages"."id" ASC LIMIT $2::int OFFSET $3::int', ["msg_01000",1001,0]],
      ],
      result: { rows: [], next: null, remainingTop: null, total: null },
    },
    {
      label: 'offset',
      set: 'Messages',
      query: '$select=id,createdAt&$orderby=createdAt desc&$skiptoken=eyJvIjoxMDAwfQ&$skip=7',
      statements: [
        ['SELECT "desk_messages"."id" AS "id", to_char("desk_messages"."created_at", \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS "createdAt", "desk_messages"."id" AS "__key" FROM "desk_messages"  ORDER BY "desk_messages"."created_at" DESC NULLS LAST, "desk_messages"."id" ASC LIMIT $1::int OFFSET $2::int', [1001,1000]],
      ],
      result: { rows: [], next: null, remainingTop: null, total: null },
    },
    {
      label: 'orderby key',
      set: 'Teams',
      query: '$select=id&$orderby=id desc',
      statements: [
        ['SELECT "helpdesk_departments"."id" AS "id", "helpdesk_departments"."id" AS "__key" FROM "helpdesk_departments" WHERE "helpdesk_departments"."deleted_at" IS NULL ORDER BY "helpdesk_departments"."id" DESC NULLS LAST LIMIT $1::int OFFSET $2::int', [1001,0]],
      ],
      result: { rows: [], next: null, remainingTop: null, total: null },
    },
    {
      label: 'top 0 with count',
      set: 'Teams',
      query: '$select=id&$top=0&$count=true',
      statements: [
        ['SELECT count(*)::text AS n FROM "helpdesk_departments" WHERE "helpdesk_departments"."deleted_at" IS NULL', []],
      ],
      result: { rows: [], next: null, remainingTop: 0, total: 0 },
    },
    {
      label: 'top above page',
      set: 'Messages',
      query: '$select=id&$top=1500',
      statements: [
        ['SELECT "desk_messages"."id" AS "id", "desk_messages"."id" AS "__key" FROM "desk_messages"  ORDER BY "desk_messages"."id" ASC LIMIT $1::int OFFSET $2::int', [1001,0]],
      ],
      result: { rows: [], next: null, remainingTop: 1500, total: null },
    },
  ])('a page: $label', async ({ set, query, statements, result }) => {
    const entitySet = findEntitySet(set)!;
    const { db, statements: ran } = recorder();
    const page = await fetchPage(db, entitySet, parseQueryOptions(new URLSearchParams(query), entitySet, 'collection'));
    expect(ran).toEqual(statements);
    expect(page).toEqual(result);
  });

  it('a count, with and without a filter, leaves soft-deleted rows out', async () => {
    const teams = findEntitySet('Teams')!;
    const messages = findEntitySet('Messages')!;
    const { db, statements } = recorder();
    await countRows(db, teams);
    await countRows(db, messages, parseFilter("kind eq 'message'", messages));
    expect(statements).toEqual([
      ['SELECT count(*)::text AS n FROM "helpdesk_departments" WHERE "helpdesk_departments"."deleted_at" IS NULL', []],
      ['SELECT count(*)::text AS n FROM "desk_messages" WHERE COALESCE("desk_messages"."kind" = $1::text, false)', ["message"]],
    ]);
  });

  it('one entity is read by its key as a bound parameter', async () => {
    const messages = findEntitySet('Messages')!;
    const { db, statements } = recorder();
    await fetchEntity(db, messages, 'msg_1', [messages.properties[0]!]);
    await fetchEntity(db, messages, "x' OR '1'='1", [messages.properties[0]!]);
    expect(statements).toEqual([
      ['SELECT "desk_messages"."id" AS "id" FROM "desk_messages" WHERE "desk_messages"."id" = $1::text LIMIT 1', ["msg_1"]],
      ['SELECT "desk_messages"."id" AS "id" FROM "desk_messages" WHERE "desk_messages"."id" = $1::text LIMIT 1', ["x' OR '1'='1"]],
    ]);
  });
});
