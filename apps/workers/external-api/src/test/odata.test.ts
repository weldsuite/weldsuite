/**
 * The OData feed end to end (`/v1/odata`) on pglite: service document,
 * `$metadata`, every entity set with its declared properties and types, the
 * query options, server paging (keyset and offset) walked to the end, `$count`,
 * single entities, the error mapping, scope and headers, and that nothing
 * sensitive is served. Seeds are fixed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeparatePgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createExternalTestApp } from './harness';
import { ODATA_ENTITY_SETS, type EdmType, type ODataEntitySet } from '@weldsuite/desk-domain/odata-catalog';
import { metadataXml, xmlEscape } from '../routes/v1/odata/metadata';
import type { Database } from '../db';

let db: Database;

const ts = (value: string) => sql`${value}::timestamp`;

async function seed() {
  await db.execute(sql`TRUNCATE desk_conversations, desk_messages, desk_sla_clocks, voip_calls, helpdesk_departments, helpdesk_ticket_types, workspace_members, desk_problems, desk_catalog_items, helpdesk_articles CASCADE`);

  await db.execute(sql`
    insert into desk_conversations (id, conversation_number, title, state, channel, visitor_id, name, email, contact_id, assignee_id, ticket_type_id, priority, impact, urgency, tags, department_id,
      created_at, updated_at, waiting_since, last_message_at, last_message_preview, rating, rating_comment, rated_at, external_id, sla_policy_id, sla_status, sla_due_at, sla_metric,
      first_response_at, first_response_seconds, resolved_at, resolution_seconds, parent_conversation_id, is_major_incident, merged_into_id, language, problem_id, catalog_item_id, approval_status)
    values ('cnv_1', 1, 'Printer broken', 'open', 'email', 'vis_secret', 'Ann', 'ann@x.test', 'ct_1', 'usr_1', 'tt_1', 'high', 'high', 'medium', '["vip","hardware"]'::jsonb, 'dep_1',
      ${ts('2026-01-10 09:00:00')}, ${ts('2026-01-11 10:00:00.25')}, ${ts('2026-01-10 09:05:00')}, ${ts('2026-01-10 09:30:00')}, 'preview-secret', 5, 'comment-secret', ${ts('2026-01-10 10:00:00')}, 'ext-1', 'sla_1', 'warning', ${ts('2026-01-10 17:00:00')}, 'resolution',
      ${ts('2026-01-10 09:02:00')}, 120, ${ts('2026-01-10 10:00:00')}, 3600, 'cnv_parent', true, 'cnv_m', 'en', 'prb_1', 'cat_1', 'approved')
  `);
  await db.execute(sql`
    insert into desk_conversations (id, conversation_number, title, state, channel, tags, created_at, first_response_seconds, priority) values
      ('cnv_2', 2, 'Can''t login 100% sure_', 'closed', 'messenger', '[]'::jsonb, ${ts('2026-01-31 23:59:59.5')}, 30, 'low'),
      ('cnv_3', 3, null, 'open', 'phone', '["hardware"]'::jsonb, ${ts('2026-02-01 00:00:00')}, null, null),
      ('cnv_4', 4, 'Invoice question', 'closed', 'email', '["billing"]'::jsonb, ${ts('2025-12-31 12:00:00')}, null, null),
      ('cnv_5', 5, 'O''Brien', 'open', 'api', '[]'::jsonb, ${ts('2026-03-15 08:30:00')}, null, null)
  `);
  await db.execute(sql`update desk_conversations set rating = 3 where id = 'cnv_3'`);

  // 2 300 messages: 37 distinct minutes, so `createdAt` ties heavily and the key breaks them.
  await db.execute(sql`
    insert into desk_messages (id, created_at, conversation_id, kind, body, author_type, author_id, attachments, metadata)
    select 'msg_' || lpad(i::text, 5, '0'), timestamp '2026-01-01 00:00:00' + ((i % 37) * interval '1 minute'), 'cnv_' || (i % 5 + 1),
      case when i % 7 = 0 then 'event' else 'message' end, 'secret body ' || i, 'agent', 'usr_1',
      '[{"name":"a","url":"https://secret.example/a.pdf"}]'::jsonb, case when i = 1 then '{"eventType":"closed"}'::jsonb else null end
    from generate_series(1, 2300) i
  `);

  await db.execute(sql`
    insert into desk_sla_clocks (id, created_at, updated_at, conversation_id, metric, policy_id, target_minutes, warn_before_minutes, calendar, status, started_at, elapsed_seconds, due_at, warn_at, breached_at, completed_at, warned_at, breach_notified_at, next_check_at)
    values ('slc_1', ${ts('2026-01-10 09:00:00')}, ${ts('2026-01-10 09:10:00')}, 'cnv_1', 'first_response', 'sla_1', 60, 15, '{"timezone":"secret-calendar"}'::jsonb, 'completed', ${ts('2026-01-10 09:00:00')}, 120,
      ${ts('2026-01-10 10:00:00')}, ${ts('2026-01-10 09:45:00')}, null, ${ts('2026-01-10 09:02:00')}, ${ts('2026-01-10 09:46:00')}, ${ts('2026-01-10 10:01:00')}, ${ts('2026-01-10 10:05:00')})
  `);

  await db.execute(sql`
    insert into voip_calls (id, created_at, user_id, direction, status, from_number, to_number, initiated_at, answered_at, ended_at, duration, queue_entered_at, agent_answered_at, answered_by_user_id, outcome, department_id,
      desk_conversation_id, is_recorded, recording_storage_key, recording_storage_url, hangup_cause, sip_trunk_id, notes, ai_summary)
    values ('call_1', ${ts('2026-01-10 08:00:00')}, 'usr_1', 'inbound', 'completed', '+31201234567', '+31207654321', ${ts('2026-01-10 08:00:00')}, ${ts('2026-01-10 08:00:20')}, ${ts('2026-01-10 08:05:20')}, 300, ${ts('2026-01-10 08:00:05')},
      ${ts('2026-01-10 08:00:20')}, 'usr_1', 'answered', 'dep_1', 'cnv_1', true, 'recordings/secret-key', 'https://secret.example/rec.mp3', 'normal_clearing', 'sip_1', 'private note', 'private summary')
  `);

  await db.execute(sql`
    insert into helpdesk_departments (id, name, description, email, manager_id, manager_name, agent_ids, agent_count, auto_assignment, round_robin_assignment, default_priority, is_active, sort_order, created_at, updated_at, deleted_at)
    values ('team_1', 'Support', 'First line', 'support@x.test', 'usr_1', 'Ann Agent', '["usr_1","usr_2"]'::jsonb, 2, true, false, 'medium', true, 1, ${ts('2026-01-01 00:00:00')}, ${ts('2026-01-02 00:00:00')}, null),
           ('team_gone', 'Removed', null, null, null, null, null, 0, false, false, 'medium', false, 2, ${ts('2026-01-01 00:00:00')}, ${ts('2026-01-02 00:00:00')}, ${ts('2026-01-03 00:00:00')})
  `);
  await db.execute(sql`
    insert into helpdesk_ticket_types (id, name, description, category, disable_ai_autofill, default_priority, default_assignee_id, default_department_id, sort_order, is_active, created_at, updated_at, deleted_at)
    values ('tt_1', 'Incident', 'Something broke', 'customer', false, 'high', 'usr_1', 'team_1', 1, true, ${ts('2026-01-01 00:00:00')}, ${ts('2026-01-02 00:00:00')}, null),
           ('tt_gone', 'Removed', null, 'customer', false, null, null, null, 2, true, ${ts('2026-01-01 00:00:00')}, ${ts('2026-01-02 00:00:00')}, ${ts('2026-01-03 00:00:00')})
  `);
  await db.execute(sql`
    insert into workspace_members (id, user_id, email, name, role, status, member_type, title, phone, bio, created_at, updated_at, deleted_at) values
      ('mem_1', 'usr_1', 'ann@agent.test', 'Ann Agent', 'ADMIN', 'ACTIVE', 'INTERNAL', 'Lead', '+310000', 'private bio', '2026-01-10 09:00:00+02', '2026-01-11 09:00:00+02', null),
      ('mem_2', 'usr_2', 'bob@agent.test', 'Bob', 'MEMBER', 'INVITED', 'INTERNAL', null, null, null, '2026-01-12 00:00:00+00', '2026-01-12 00:00:00+00', null),
      ('mem_3', 'usr_3', 'gone@agent.test', 'Gone', 'MEMBER', 'ACTIVE', 'INTERNAL', null, null, null, '2026-01-12 00:00:00+00', '2026-01-12 00:00:00+00', '2026-01-13 00:00:00+00')
  `);
  await db.execute(sql`
    insert into desk_problems (id, created_at, updated_at, problem_number, title, description, status, priority, root_cause, workaround, resolution, assignee_id, department_id, article_id, known_error_at, resolved_at, closed_at, created_by_id)
    values ('prb_1', ${ts('2026-01-05 00:00:00')}, ${ts('2026-01-06 00:00:00')}, 1, 'Printer spooler', 'Spooler hangs', 'known_error', 'high', 'Driver bug', 'Restart it', 'Update the driver', 'usr_1', 'team_1', 'art_1',
      ${ts('2026-01-05 12:00:00')}, ${ts('2026-01-06 00:00:00')}, ${ts('2026-01-07 00:00:00')}, 'usr_1')
  `);
  await db.execute(sql`
    insert into desk_catalog_items (id, name, summary, description, category, ticket_type_id, department_id, is_active, created_at, updated_at)
    values ('cat_1', 'New laptop', 'secret summary', 'secret description', 'Hardware', 'tt_1', 'team_1', true, ${ts('2026-01-01 00:00:00')}, ${ts('2026-01-02 00:00:00')})
  `);
  await db.execute(sql`
    insert into helpdesk_articles (id, title, slug, content, status, visibility, locale, category_id, category_name, author_id, view_count, like_count, dislike_count, helpful_count, not_helpful_count, created_at, updated_at, published_at, deleted_at)
    values ('art_1', 'Reset your password', 'reset', 'secret article body', 'published', 'public', 'en', null, 'Accounts', 'usr_1', 10, 3, 1, 4, 2, ${ts('2026-01-01 00:00:00')}, ${ts('2026-01-02 00:00:00')}, ${ts('2026-01-03 00:00:00')}, null),
           ('art_gone', 'Removed', 'gone', 'x', 'draft', 'public', null, null, null, 'usr_1', 0, 0, 0, 0, 0, ${ts('2026-01-01 00:00:00')}, ${ts('2026-01-02 00:00:00')}, null, ${ts('2026-01-04 00:00:00')})
  `);
}

beforeAll(async () => {
  db = (await createSeparatePgliteDb()).db as unknown as Database;
  await seed();
}, 180_000);

const appWith = (scopes: string[]) => createExternalTestApp({ scopes, tenantDb: db });
const app = () => appWith(['reports:read']);

interface Body {
  '@odata.context': string;
  '@odata.count'?: number;
  '@odata.nextLink'?: string;
  value: Record<string, unknown>[];
}

const enc = encodeURIComponent;
/** A request path with its options percent-encoded the way a client sends them. */
const url = (path: string, options: Record<string, string> = {}) => {
  const query = Object.entries(options).map(([k, v]) => `${k.startsWith('$') ? '$' + enc(k.slice(1)) : enc(k)}=${enc(v)}`);
  return query.length ? `${path}?${query.join('&')}` : path;
};

async function get(path: string, options: Record<string, string> = {}): Promise<Body> {
  const res = await app().request(url(path, options));
  const text = await res.text();
  expect(res.status, `${path} ${JSON.stringify(options)}: ${text}`).toBe(200);
  return JSON.parse(text) as Body;
}

async function errorOf(path: string, options: Record<string, string> = {}, status = 400) {
  const res = await app().request(url(path, options));
  const text = await res.text();
  expect(res.status, `${path} ${JSON.stringify(options)}: ${text}`).toBe(status);
  const body = JSON.parse(text) as { error: { code: string; message: string } };
  expect(typeof body.error.message).toBe('string');
  return body.error;
}

const ids = (body: Body) => body.value.map((row) => row.id);
const filtered = async (filter: string) => ids(await get('/v1/odata/Conversations', { $filter: filter, $orderby: 'conversationNumber' }));

function assertWellFormed(xml: string) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos);[^"<&]*)*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(body))) {
    const text = body.slice(last, match.index);
    expect(text.trim(), 'text between tags').toBe('');
    last = tag.lastIndex;
    const [, closing, name, , selfClosing] = match;
    if (closing) expect(stack.pop(), `closing ${name}`).toBe(name);
    else if (!selfClosing) stack.push(name!);
  }
  expect(body.slice(last).trim()).toBe('');
  expect(stack).toEqual([]);
}

function typeOk(type: EdmType, nullable: boolean, value: unknown, label: string) {
  if (value === null) {
    expect(nullable, `${label} is null but declared non-nullable`).toBe(true);
    return;
  }
  switch (type) {
    case 'Edm.String':
      expect(typeof value, label).toBe('string');
      break;
    case 'Edm.Int32':
    case 'Edm.Int64':
    case 'Edm.Double':
      expect(typeof value, label).toBe('number');
      break;
    case 'Edm.Boolean':
      expect(typeof value, label).toBe('boolean');
      break;
    case 'Edm.DateTimeOffset':
      expect(value, label).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      break;
    case 'Collection(Edm.String)':
      expect(Array.isArray(value), label).toBe(true);
      for (const item of value as unknown[]) expect(typeof item, label).toBe('string');
      break;
  }
}

describe('service document and metadata', () => {
  it('lists the entity sets', async () => {
    const res = await app().request('/v1/odata');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { '@odata.context': string; value: { name: string; kind: string; url: string }[] };
    expect(Object.keys(body)).toEqual(['@odata.context', 'value']);
    expect(body['@odata.context']).toBe('http://localhost/v1/odata/$metadata');
    expect(body.value).toEqual(ODATA_ENTITY_SETS.map((s) => ({ name: s.name, kind: 'EntitySet', url: s.name })));
    expect(body.value.map((v) => v.name)).toEqual(['Conversations', 'Messages', 'SlaClocks', 'Calls', 'Teams', 'TicketTypes', 'Agents', 'Problems', 'CatalogItems', 'Articles']);
    const slash = await (await app().request('/v1/odata/')).json();
    expect(slash).toEqual(body);
  });

  it('serves a well-formed CSDL that lists every set and property', async () => {
    const res = await app().request('/v1/odata/$metadata');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^application\/xml/);
    expect(res.headers.get('OData-Version')).toBe('4.0');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const xml = await res.text();
    assertWellFormed(xml);
    expect(xml).toBe(metadataXml());
    expect(xml).toContain('<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">');
    expect(xml).toContain('Namespace="WeldSuite.Desk" xmlns="http://docs.oasis-open.org/odata/ns/edm"');
    expect(xml).toContain('<EntityContainer Name="Feed">');
    for (const set of ODATA_ENTITY_SETS) {
      expect(xml).toContain(`<EntityType Name="${set.entityType}">`);
      expect(xml).toContain(`<PropertyRef Name="${set.key}"/>`);
      expect(xml).toContain(`<EntitySet Name="${set.name}" EntityType="WeldSuite.Desk.${set.entityType}"/>`);
      for (const prop of set.properties) {
        expect(xml, `${set.name}.${prop.name}`).toContain(`<Property Name="${prop.name}" Type="${xmlEscape(prop.type)}" Nullable="${prop.nullable}"/>`);
      }
    }
    // every key is not nullable
    expect(xml).toContain('<Property Name="id" Type="Edm.String" Nullable="false"/>');
    expect(xml).toContain('<Property Name="tags" Type="Collection(Edm.String)" Nullable="false"/>');
  });

  it('escapes what it writes', () => {
    expect(xmlEscape(`a&b<c>"d"'e'`)).toBe('a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
  });

  it('uses the request origin for its URLs', async () => {
    const res = await app().request('https://api.weldsuite.org/v1/odata');
    expect(((await res.json()) as { '@odata.context': string })['@odata.context']).toBe('https://api.weldsuite.org/v1/odata/$metadata');
  });
});

describe('entity sets', () => {
  const counts: Record<string, number> = {
    Conversations: 5,
    Messages: 2300,
    SlaClocks: 1,
    Calls: 1,
    Teams: 1,
    TicketTypes: 1,
    Agents: 2,
    Problems: 1,
    CatalogItems: 1,
    Articles: 1,
  };

  for (const set of ODATA_ENTITY_SETS as ODataEntitySet[]) {
    it(`${set.name} returns rows with exactly its declared properties and types`, async () => {
      const body = await get(`/v1/odata/${set.name}`, { $top: '20' });
      expect(body['@odata.context']).toBe(`http://localhost/v1/odata/$metadata#${set.name}`);
      expect(body.value).toHaveLength(Math.min(counts[set.name]!, 20));
      for (const row of body.value) {
        expect(Object.keys(row), set.name).toEqual(set.properties.map((p) => p.name));
        for (const prop of set.properties) typeOk(prop.type, prop.nullable, row[prop.name], `${set.name}.${prop.name}`);
      }
      const count = await app().request(`/v1/odata/${set.name}/$count`);
      expect(await count.text()).toBe(String(counts[set.name]));
    });
  }

  it('serves a conversation in full, timestamps in UTC with Z', async () => {
    const body = await get("/v1/odata/Conversations('cnv_1')");
    const { '@odata.context': context, ...entity } = body as unknown as Record<string, unknown>;
    expect(context).toBe("http://localhost/v1/odata/$metadata#Conversations/$entity");
    expect(entity).toEqual({
      id: 'cnv_1',
      conversationNumber: 1,
      title: 'Printer broken',
      state: 'open',
      channel: 'email',
      name: 'Ann',
      email: 'ann@x.test',
      contactId: 'ct_1',
      assigneeId: 'usr_1',
      ticketTypeId: 'tt_1',
      priority: 'high',
      impact: 'high',
      urgency: 'medium',
      tags: ['vip', 'hardware'],
      departmentId: 'dep_1',
      createdAt: '2026-01-10T09:00:00.000Z',
      updatedAt: '2026-01-11T10:00:00.250Z',
      waitingSince: '2026-01-10T09:05:00.000Z',
      lastMessageAt: '2026-01-10T09:30:00.000Z',
      rating: 5,
      ratedAt: '2026-01-10T10:00:00.000Z',
      externalId: 'ext-1',
      slaPolicyId: 'sla_1',
      slaStatus: 'warning',
      slaDueAt: '2026-01-10T17:00:00.000Z',
      slaMetric: 'resolution',
      firstResponseAt: '2026-01-10T09:02:00.000Z',
      firstResponseSeconds: 120,
      resolvedAt: '2026-01-10T10:00:00.000Z',
      resolutionSeconds: 3600,
      parentConversationId: 'cnv_parent',
      isMajorIncident: true,
      mergedIntoId: 'cnv_m',
      language: 'en',
      problemId: 'prb_1',
      catalogItemId: 'cat_1',
      approvalStatus: 'approved',
    });
  });

  it('gives nulls as null and an empty collection as []', async () => {
    const row = ((await get("/v1/odata/Conversations('cnv_2')")) as unknown as Record<string, unknown>);
    expect(row.tags).toEqual([]);
    expect(row.title).toBe("Can't login 100% sure_");
    expect(row.waitingSince).toBeNull();
    expect(row.rating).toBeNull();
    expect(row.createdAt).toBe('2026-01-31T23:59:59.500Z');
    const team = await get('/v1/odata/Teams');
    expect(team.value[0]!.agentIds).toEqual(['usr_1', 'usr_2']);
  });

  it('derives the message event type, a member\'s active flag and reads timestamptz as UTC', async () => {
    const closed = await get('/v1/odata/Messages', { $filter: "eventType eq 'closed'" });
    expect(ids(closed)).toEqual(['msg_00001']);
    expect(closed.value[0]!.eventType).toBe('closed');
    const agents = await get('/v1/odata/Agents', { $orderby: 'id' });
    expect(agents.value.map((a) => [a.id, a.isActive])).toEqual([['mem_1', true], ['mem_2', false]]);
    expect(agents.value[0]).toMatchObject({ createdAt: '2026-01-10T07:00:00.000Z', updatedAt: '2026-01-11T07:00:00.000Z', role: 'ADMIN', email: 'ann@agent.test' });
    expect(ids(await get('/v1/odata/Agents', { $filter: 'isActive eq true' }))).toEqual(['mem_1']);
    expect(ids(await get('/v1/odata/Agents', { $filter: 'createdAt lt 2026-01-10T07:30:00Z' }))).toEqual(['mem_1']);
  });

  it('does not serve soft-deleted rows', async () => {
    expect(ids(await get('/v1/odata/Teams'))).toEqual(['team_1']);
    expect(ids(await get('/v1/odata/TicketTypes'))).toEqual(['tt_1']);
    expect(ids(await get('/v1/odata/Articles'))).toEqual(['art_1']);
    await errorOf("/v1/odata/Teams('team_gone')", {}, 404);
    await errorOf("/v1/odata/Agents('mem_3')", {}, 404);
    expect(await (await app().request('/v1/odata/Articles/$count')).text()).toBe('1');
  });

  it('never serves message bodies, attachments, recordings, secrets or private columns', async () => {
    const forbidden = [
      'secret body', 'secret.example', 'https://', 'recordings/secret-key', 'private note', 'private summary', 'secret-calendar',
      'vis_secret', 'preview-secret', 'comment-secret', 'secret summary', 'secret description', 'secret article body', 'private bio', '+310000',
    ];
    for (const set of ODATA_ENTITY_SETS) {
      const res = await app().request(`/v1/odata/${set.name}?$top=5`);
      const text = await res.text();
      for (const word of forbidden) expect(text, `${set.name} leaks ${word}`).not.toContain(word);
      for (const key of ['"body"', '"attachments"', '"metadata"', '"recordingStorageUrl"', '"content"', '"calendar"']) expect(text).not.toContain(key);
    }
  });
});

describe('query options', () => {
  it('$select returns only the chosen properties, with them in the context URL', async () => {
    const body = await get('/v1/odata/Conversations', { $select: 'title,id', $orderby: 'conversationNumber', $top: '2' });
    expect(body['@odata.context']).toBe('http://localhost/v1/odata/$metadata#Conversations(id,title)');
    expect(body.value).toEqual([
      { id: 'cnv_1', title: 'Printer broken' },
      { id: 'cnv_2', title: "Can't login 100% sure_" },
    ]);
    const key = await get('/v1/odata/Conversations', { $select: 'title', $top: '1' });
    expect(key.value).toEqual([{ title: 'Printer broken' }]);
    expect((await get('/v1/odata/Conversations', { $select: '*', $top: '1' })).value[0]).toHaveProperty('slaDueAt');
    const dedup = await get('/v1/odata/Conversations', { $select: 'id,id', $top: '1' });
    expect(Object.keys(dedup.value[0]!)).toEqual(['id']);
    const one = await get("/v1/odata/Conversations('cnv_1')", { $select: 'id,tags' });
    expect(one).toEqual({ '@odata.context': "http://localhost/v1/odata/$metadata#Conversations(id,tags)/$entity", id: 'cnv_1', tags: ['vip', 'hardware'] });
  });

  it('rejects an unknown or unsafe $select', async () => {
    for (const select of ['nope', 'id,', ',id', 'id;drop table x', 'id desc', '"id"', 'tags/x']) {
      const status = select === 'tags/x' ? 501 : 400;
      await errorOf('/v1/odata/Conversations', { $select: select }, status);
    }
  });

  it('applies $skip before $top', async () => {
    const page = await get('/v1/odata/Conversations', { $orderby: 'conversationNumber', $skip: '1', $top: '2' });
    expect(ids(page)).toEqual(['cnv_2', 'cnv_3']);
    expect(page['@odata.nextLink']).toBeUndefined();
    expect(ids(await get('/v1/odata/Conversations', { $skip: '4' }))).toEqual(['cnv_5']);
    expect((await get('/v1/odata/Conversations', { $skip: '99' })).value).toEqual([]);
    expect((await get('/v1/odata/Conversations', { $top: '0' })).value).toEqual([]);
    // no $orderby: key order, skip and top still apply
    expect(ids(await get('/v1/odata/Conversations', { $skip: '1', $top: '1' }))).toEqual(['cnv_2']);
  });

  it('rejects a bad $top, $skip or $count', async () => {
    for (const [name, value] of [['$top', '-1'], ['$top', 'abc'], ['$top', '1.5'], ['$skip', '-2'], ['$skip', 'x'], ['$top', ''], ['$count', 'yes'], ['$count', '1']] as const) {
      await errorOf('/v1/odata/Conversations', { [name]: value });
    }
  });

  it('$orderby sorts, with direction, several terms and the key as tie-breaker', async () => {
    expect(ids(await get('/v1/odata/Conversations', { $orderby: 'createdAt desc' }))).toEqual(['cnv_5', 'cnv_3', 'cnv_2', 'cnv_1', 'cnv_4']);
    expect(ids(await get('/v1/odata/Conversations', { $orderby: 'createdAt asc' }))).toEqual(['cnv_4', 'cnv_1', 'cnv_2', 'cnv_3', 'cnv_5']);
    expect(ids(await get('/v1/odata/Conversations', { $orderby: 'state, conversationNumber desc' }))).toEqual(['cnv_4', 'cnv_2', 'cnv_5', 'cnv_3', 'cnv_1']);
    // nulls sort lowest: first ascending, last descending
    expect(ids(await get('/v1/odata/Conversations', { $orderby: 'title' }))[0]).toBe('cnv_3');
    expect(ids(await get('/v1/odata/Conversations', { $orderby: 'title desc' })).pop()).toBe('cnv_3');
    // ties on `state` fall back to the key
    expect(ids(await get('/v1/odata/Conversations', { $orderby: 'state' }))).toEqual(['cnv_2', 'cnv_4', 'cnv_1', 'cnv_3', 'cnv_5']);
  });

  it('rejects a bad $orderby', async () => {
    for (const orderby of ['nope', 'tags', 'id sideways', 'id desc desc', 'id; drop table x', 'description', ',id', 'a,b,c,d,e,f']) {
      await errorOf(orderby === 'description' ? '/v1/odata/Problems' : '/v1/odata/Conversations', { $orderby: orderby });
    }
    await errorOf('/v1/odata/Conversations', { $orderby: 'tolower(title)' }, 501);
  });

  it('$count=true puts @odata.count second and counts all matches, not the page', async () => {
    const body = await get('/v1/odata/Conversations', { $count: 'true', $top: '2' });
    expect(Object.keys(body)).toEqual(['@odata.context', '@odata.count', 'value']);
    expect(body['@odata.count']).toBe(5);
    expect(body.value).toHaveLength(2);
    const filteredBody = await get('/v1/odata/Conversations', { $count: 'true', $filter: "state eq 'open'" });
    expect(filteredBody['@odata.count']).toBe(3);
    expect((await get('/v1/odata/Conversations', { $count: 'false' }))['@odata.count']).toBeUndefined();
    expect((await get('/v1/odata/Conversations'))['@odata.count']).toBeUndefined();
  });

  it('/$count answers text/plain, honours $filter and refuses other options', async () => {
    const res = await app().request('/v1/odata/Conversations/$count');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/);
    expect(res.headers.get('OData-Version')).toBe('4.0');
    expect(await res.text()).toBe('5');
    expect(await (await app().request(url('/v1/odata/Conversations/$count', { $filter: "state eq 'open'" }))).text()).toBe('3');
    expect(await (await app().request(url('/v1/odata/Conversations/$count', { $filter: "state eq 'nope'" }))).text()).toBe('0');
    await errorOf('/v1/odata/Conversations/$count', { $top: '1' });
    await errorOf('/v1/odata/Conversations/$count', { $filter: 'nope eq 1' });
  });

  it('$format=json is accepted, anything else is 415', async () => {
    await get('/v1/odata/Teams', { $format: 'json' });
    await get('/v1/odata/Teams', { $format: 'application/json;odata.metadata=minimal' });
    for (const format of ['xml', 'atom', 'application/xml', 'csv']) await errorOf('/v1/odata/Teams', { $format: format }, 415);
  });
});

describe('$filter over HTTP', () => {
  it('compares strings, numbers, booleans and combines them', async () => {
    expect(await filtered("state eq 'open'")).toEqual(['cnv_1', 'cnv_3', 'cnv_5']);
    expect(await filtered("state eq 'open' and channel eq 'email'")).toEqual(['cnv_1']);
    expect(await filtered("title eq 'Invoice question' or title eq null")).toEqual(['cnv_3', 'cnv_4']);
    expect(await filtered("not (state eq 'open')")).toEqual(['cnv_2', 'cnv_4']);
    expect(await filtered('isMajorIncident eq true')).toEqual(['cnv_1']);
    expect(await filtered('firstResponseSeconds gt 100')).toEqual(['cnv_1']);
    expect(await filtered('100 lt firstResponseSeconds')).toEqual(['cnv_1']);
    expect(await filtered('rating ge 3')).toEqual(['cnv_1', 'cnv_3']);
    expect(await filtered('conversationNumber ge 2 and conversationNumber lt 4')).toEqual(['cnv_2', 'cnv_3']);
    expect(await filtered("(state eq 'open' or state eq 'closed') and priority eq 'low'")).toEqual(['cnv_2']);
  });

  it('handles quotes, null and its OData semantics', async () => {
    expect(await filtered("title eq 'O''Brien'")).toEqual(['cnv_5']);
    expect(await filtered('title eq null')).toEqual(['cnv_3']);
    expect(await filtered('title ne null')).toEqual(['cnv_1', 'cnv_2', 'cnv_4', 'cnv_5']);
    expect(await filtered('rating eq null')).toEqual(['cnv_2', 'cnv_4', 'cnv_5']);
    // ne is true for a null value, a comparison with null is false so `not` of it is true
    expect(await filtered("title ne 'Printer broken'")).toEqual(['cnv_2', 'cnv_3', 'cnv_4', 'cnv_5']);
    expect(await filtered("not (title eq 'Printer broken')")).toEqual(['cnv_2', 'cnv_3', 'cnv_4', 'cnv_5']);
    expect(await filtered("title gt 'P'")).toEqual(['cnv_1']);
  });

  it('matches contains, startswith and endswith literally', async () => {
    expect(await filtered("contains(title,'login')")).toEqual(['cnv_2']);
    expect(await filtered("contains(title,'100%')")).toEqual(['cnv_2']);
    expect(await filtered("contains(title,'%')")).toEqual(['cnv_2']);
    expect(await filtered("contains(title,'_')")).toEqual(['cnv_2']);
    expect(await filtered("contains(title,'n')")).toEqual(['cnv_1', 'cnv_2', 'cnv_4', 'cnv_5']);
    expect(await filtered("contains(title,'printer')")).toEqual([]);
    expect(await filtered("startswith(title,'Print')")).toEqual(['cnv_1']);
    expect(await filtered("endswith(title,'question')")).toEqual(['cnv_4']);
    expect(await filtered("startswith(title,'%')")).toEqual([]);
    expect(await filtered("not contains(title,'o')")).toEqual(['cnv_3', 'cnv_5']);
  });

  it('filters a collection with any()', async () => {
    expect(await filtered("tags/any(t: t eq 'hardware')")).toEqual(['cnv_1', 'cnv_3']);
    expect(await filtered("tags/any(t: t eq 'vip')")).toEqual(['cnv_1']);
    expect(await filtered("tags/any(t: t eq 'nope')")).toEqual([]);
    expect(await filtered("not tags/any(t: t eq 'hardware')")).toEqual(['cnv_2', 'cnv_4', 'cnv_5']);
    expect(ids(await get('/v1/odata/Teams', { $filter: "agentIds/any(a: a eq 'usr_2')" }))).toEqual(['team_1']);
  });

  it('filters dates: instants, offsets, bare dates and parts', async () => {
    expect(await filtered('createdAt ge 2026-01-31T00:00:00Z')).toEqual(['cnv_2', 'cnv_3', 'cnv_5']);
    expect(await filtered('createdAt gt 2026-01-31T23:59:59.499Z and createdAt lt 2026-01-31T23:59:59.501Z')).toEqual(['cnv_2']);
    expect(await filtered('createdAt eq 2026-01-31')).toEqual(['cnv_2']);
    expect(await filtered('createdAt ne 2026-01-31')).toEqual(['cnv_1', 'cnv_3', 'cnv_4', 'cnv_5']);
    expect(await filtered('createdAt gt 2026-01-31')).toEqual(['cnv_2', 'cnv_3', 'cnv_5']);
    expect(await filtered('createdAt lt 2026-01-01')).toEqual(['cnv_4']);
    expect(await filtered('createdAt le 2026-01-10T11:00:00+02:00')).toEqual(['cnv_1', 'cnv_4']);
    expect(await filtered('createdAt lt 2026-01-10T11:00:00+02:00')).toEqual(['cnv_4']);
    expect(await filtered('createdAt lt 2026-01-10T04:00:00-05:00')).toEqual(['cnv_4']);
    expect(await filtered('year(createdAt) eq 2026 and month(createdAt) eq 1')).toEqual(['cnv_1', 'cnv_2']);
    expect(await filtered('day(createdAt) eq 31')).toEqual(['cnv_2', 'cnv_4']);
    expect(await filtered('year(createdAt) lt 2026')).toEqual(['cnv_4']);
    expect(await filtered('waitingSince eq null')).toEqual(['cnv_2', 'cnv_3', 'cnv_4', 'cnv_5']);
    // The last day there is: it ends in the year 10000, which the database still reads.
    expect(await filtered('createdAt eq 9999-12-31')).toEqual([]);
    expect(await filtered('createdAt ne 9999-12-31')).toEqual(['cnv_1', 'cnv_2', 'cnv_3', 'cnv_4', 'cnv_5']);
    expect(await filtered('createdAt lt 9999-12-31')).toEqual(['cnv_1', 'cnv_2', 'cnv_3', 'cnv_4', 'cnv_5']);
  });

  it('takes an unencoded + in an offset as a plus', async () => {
    const res = await app().request(`/v1/odata/Conversations?$filter=createdAt le 2026-01-10T11:00:00+02:00&$orderby=conversationNumber`);
    expect(res.status).toBe(200);
    expect(ids((await res.json()) as Body)).toEqual(['cnv_1', 'cnv_4']);
  });

  it('works on the other sets', async () => {
    expect(ids(await get('/v1/odata/Problems', { $filter: "status eq 'known_error' and contains(rootCause,'Driver')" }))).toEqual(['prb_1']);
    expect(ids(await get('/v1/odata/Calls', { $filter: 'duration ge 300 and isRecorded eq true' }))).toEqual(['call_1']);
    expect(ids(await get('/v1/odata/Calls', { $filter: "direction eq 'outbound'" }))).toEqual([]);
    expect(ids(await get('/v1/odata/SlaClocks', { $filter: "metric eq 'first_response' and breachedAt eq null" }))).toEqual(['slc_1']);
    expect(ids(await get('/v1/odata/Articles', { $filter: 'helpfulCount gt 3' }))).toEqual(['art_1']);
    expect(ids(await get('/v1/odata/Messages', { $filter: "kind eq 'event' and conversationId eq 'cnv_1'", $top: '3' }))).toHaveLength(3);
  });

  it('answers 400 for malformed input and 501 for what it does not serve', async () => {
    for (const filter of ["nope eq 'a'", 'title eq', "title eq 5", "title eq 'x", "state eq 'a' AND state eq 'b'", 'rating eq 1.5', 'tags eq 1', `title eq '${'x'.repeat(2001)}'`]) {
      const error = await errorOf('/v1/odata/Conversations', { $filter: filter });
      expect(error.code, filter).toBe('BadRequest');
    }
    for (const filter of ["tolower(title) eq 'a'", "tags/all(t: t eq 'a')", 'title/length gt 1']) {
      const error = await errorOf('/v1/odata/Conversations', { $filter: filter }, 501);
      expect(error.code, filter).toBe('NotImplemented');
    }
    await errorOf('/v1/odata/Conversations', { $filter: '' });
  });

  it('answers 400 for a NUL character in a string literal, percent-encoded or raw', async () => {
    const message = 'A string literal in $filter must not contain a NUL character';
    const filters = ["title eq 'a\u0000b'", "contains(title,'\u0000')", "tags/any(t: t eq 'vip\u0000')", "title eq 'x' or title eq '\u0000'"];
    for (const filter of filters) {
      expect(await errorOf('/v1/odata/Conversations', { $filter: filter }), JSON.stringify(filter)).toEqual({ code: 'BadRequest', message });
    }
    expect((await errorOf('/v1/odata/Conversations/$count', { $filter: "title eq '\u0000'" })).message).toBe(message);
    // As a client's own query string carries it.
    const raw = await app().request("/v1/odata/Conversations?$filter=title eq 'a\u0000b'");
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as { error: { message: string } }).error.message).toBe(message);
  });

  it('cannot be injected through a literal or a name', async () => {
    const before = await (await app().request('/v1/odata/Conversations/$count')).text();
    expect(await filtered("title eq 'x''; DROP TABLE desk_conversations; --'")).toEqual([]);
    expect(await filtered("title eq ''' OR 1=1 --'")).toEqual([]);
    expect(await filtered("contains(title,'%'' OR ''1''=''1')")).toEqual([]);
    await errorOf('/v1/odata/Conversations', { $filter: 'id; DROP TABLE desk_conversations eq 1' });
    await errorOf('/v1/odata/Conversations', { $orderby: 'id; DROP TABLE desk_conversations' });
    await errorOf('/v1/odata/Conversations', { $select: 'id,(select 1)' });
    await errorOf("/v1/odata/Conversations('x'; DROP TABLE desk_conversations)");
    expect(await (await app().request('/v1/odata/Conversations/$count')).text()).toBe(before);
    const sneaky = await app().request(url("/v1/odata/Conversations('cnv_1'' OR ''1''=''1')"));
    expect(sneaky.status).toBe(404);
  });
});

describe('single entities', () => {
  it('reads one by key, also with the quote percent-encoded', async () => {
    expect(((await get("/v1/odata/Teams('team_1')")) as unknown as Record<string, unknown>).name).toBe('Support');
    const encoded = await app().request('/v1/odata/Teams(%27team_1%27)');
    expect(encoded.status).toBe(200);
    expect(((await encoded.json()) as { id: string }).id).toBe('team_1');
  });

  it('answers 404 for an unknown key, 400 for a key that is not a quoted string', async () => {
    await errorOf("/v1/odata/Teams('nope')", {}, 404);
    await errorOf('/v1/odata/Teams(team_1)', {}, 400);
    await errorOf('/v1/odata/Teams(1)', {}, 400);
    await errorOf("/v1/odata/Teams('team_1')", { $filter: "name eq 'x'" }, 400);
    await errorOf("/v1/odata/Teams('team_1')", { $top: '1' }, 400);
  });

  // A set name is ASCII letters, digits and `_`; the key is what stands between the first `(` and the last `)`.
  it.each<[string, number, string]>([
    ['/v1/odata/Nope', 404, "The entity set 'Nope' does not exist"],
    ['/v1/odata/Te_ams9', 404, "The entity set 'Te_ams9' does not exist"],
    ['/v1/odata/_', 404, "The entity set '_' does not exist"],
    ['/v1/odata/9', 404, "The entity set '9' does not exist"],
    [`/v1/odata/${'a'.repeat(3000)}`, 404, `The entity set '${'a'.repeat(3000)}' does not exist`],
    ['/v1/odata/Te%C3%A9ms', 404, 'Resource not found: Teéms'],
    ['/v1/odata/Teams%C5%BF', 404, 'Resource not found: Teamsſ'],
    ['/v1/odata/Teams%E2%84%AA', 404, 'Resource not found: TeamsK'],
    ['/v1/odata/%D9%A3', 404, 'Resource not found: ٣'],
    ['/v1/odata/Te-ams', 404, 'Resource not found: Te-ams'],
    ['/v1/odata/Teams%20', 404, 'Resource not found: Teams '],
    ['/v1/odata/Teams%0A', 404, 'Resource not found: Teams\n'],
    ['/v1/odata/(x)', 404, 'Resource not found: (x)'],
    ["/v1/odata/Teams('x'", 404, "Resource not found: Teams('x'"],
    ["/v1/odata/Teams('x')y", 404, "Resource not found: Teams('x')y"],
    ["/v1/odata/Teams('a')('b')", 400, "A key must be a string in single quotes, like Conversations('cnv_1')"],
    ["/v1/odata/Teams('a'b')", 400, "A key must be a string in single quotes, like Conversations('cnv_1')"],
    ["/v1/odata/Teams('te''am')", 404, "Team 'te'am' not found"],
    ["/v1/odata/Teams('a%0Ab')", 404, "Team 'a\nb' not found"],
    ["/v1/odata/Nope('x')", 404, "The entity set 'Nope' does not exist"],
  ])('answers %j with %i', async (path, status, message) => {
    expect((await errorOf(path, {}, status)).message).toBe(message);
  });

  it('answers 400 for a NUL character in a key, percent-encoded or raw', async () => {
    const paths = [
      "/v1/odata/Teams('a%00b')",
      "/v1/odata/Teams('%00')",
      "/v1/odata/Teams('team_1\u0000')",
      "/v1/odata/Teams('te''am%00')",
      "/v1/odata/Teams('%00')/$count",
      "/v1/odata/Nope('%00')",
    ];
    for (const path of paths) {
      expect(await errorOf(path), path).toEqual({ code: 'BadRequest', message: 'A key must not contain a NUL character' });
    }
  });

  it('reads Teams() as the collection', async () => {
    expect((await get('/v1/odata/Teams()')).value).toHaveLength(1);
  });
});

describe('server paging', () => {
  const MESSAGE_IDS = Array.from({ length: 2300 }, (_, i) => `msg_${String(i + 1).padStart(5, '0')}`);

  async function walk(first: string, limit = 20): Promise<{ pages: Body[]; links: string[] }> {
    const pages: Body[] = [];
    const links: string[] = [];
    let next: string | undefined = first;
    while (next && pages.length < limit) {
      const res = await app().request(next);
      const text = await res.text();
      expect(res.status, `${next}: ${text}`).toBe(200);
      const page = JSON.parse(text) as Body;
      pages.push(page);
      next = page['@odata.nextLink'];
      if (next) links.push(next);
    }
    return { pages, links };
  }

  it('walks a keyset to the end: 1000 + 1000 + 300 rows, no duplicate and no gap', async () => {
    const { pages, links } = await walk('/v1/odata/Messages?$select=id');
    expect(pages.map((p) => p.value.length)).toEqual([1000, 1000, 300]);
    const seen = pages.flatMap((p) => p.value.map((row) => row.id));
    expect(seen).toEqual(MESSAGE_IDS);
    expect(Object.keys(pages[0]!)).toEqual(['@odata.context', 'value', '@odata.nextLink']);
    expect(pages[2]!['@odata.nextLink']).toBeUndefined();
    for (const link of links) {
      expect(link.startsWith('http://localhost/v1/odata/Messages?')).toBe(true);
      expect(link).toContain('$select=id');
      expect(link).toContain('$skiptoken=');
      expect(link).not.toContain('$skip=');
      expect(link).not.toContain('%24');
    }
  });

  it('walks an $orderby with offset tokens, ties and all, in the order asked', async () => {
    const { pages, links } = await walk(`/v1/odata/Messages?$select=id,createdAt&$orderby=${enc('createdAt desc')}`);
    expect(pages.map((p) => p.value.length)).toEqual([1000, 1000, 300]);
    const seen = pages.flatMap((p) => p.value);
    expect(new Set(seen.map((r) => r.id)).size).toBe(2300);
    const minute = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i % 37)).toISOString();
    const expected = MESSAGE_IDS.map((id, i) => ({ id, createdAt: minute(i + 1) })).sort(
      (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1),
    );
    expect(seen).toEqual(expected);
    for (const link of links) expect(link).toContain('createdAt%20desc');
  });

  it('keeps the filter, count and select on every page', async () => {
    const { pages } = await walk(`/v1/odata/Messages?$count=true&$select=id&$filter=${enc("kind eq 'message'")}`);
    const total = MESSAGE_IDS.filter((_, i) => (i + 1) % 7 !== 0).length;
    expect(pages.map((p) => p['@odata.count'])).toEqual(pages.map(() => total));
    expect(pages.flatMap((p) => p.value)).toHaveLength(total);
    expect(new Set(pages.flatMap((p) => p.value.map((r) => r.id))).size).toBe(total);
  });

  it('serves $top above the page size in pages and stops at $top', async () => {
    const { pages, links } = await walk('/v1/odata/Messages?$top=1500&$select=id');
    expect(pages.map((p) => p.value.length)).toEqual([1000, 500]);
    expect(links[0]).toContain('$top=500');
    expect(links[0]).not.toContain('$top=1500');
    expect(pages.flatMap((p) => p.value.map((r) => r.id))).toEqual(MESSAGE_IDS.slice(0, 1500));
    expect(pages[1]!['@odata.nextLink']).toBeUndefined();
  });

  it('serves $skip with paging, and $top up to the page size without a link', async () => {
    const skipped = await walk('/v1/odata/Messages?$skip=1200&$select=id');
    expect(skipped.pages.map((p) => p.value.length)).toEqual([1000, 100]);
    expect(skipped.pages.flatMap((p) => p.value.map((r) => r.id))).toEqual(MESSAGE_IDS.slice(1200));
    const edge = await get('/v1/odata/Messages', { $top: '1000', $select: 'id' });
    expect(edge.value).toHaveLength(1000);
    expect(edge['@odata.nextLink']).toBeUndefined();
    const small = await get('/v1/odata/Messages', { $top: '5', $select: 'id' });
    expect(small['@odata.nextLink']).toBeUndefined();
    const skipOrdered = await walk(`/v1/odata/Messages?$skip=2250&$orderby=id&$select=id`);
    expect(skipOrdered.pages.flatMap((p) => p.value.map((r) => r.id))).toEqual(MESSAGE_IDS.slice(2250));
  });

  it('refuses a skiptoken that is not ours or does not fit the query', async () => {
    await errorOf('/v1/odata/Messages', { $skiptoken: 'garbage!!' });
    await errorOf('/v1/odata/Messages', { $skiptoken: btoa('{"x":1}') });
    await errorOf('/v1/odata/Messages', { $skiptoken: btoa('{"o":-1}') });
    await errorOf('/v1/odata/Messages', { $skiptoken: btoa('{"o":5}') }); // an offset token without $orderby
    const { links } = await walk('/v1/odata/Messages?$select=id', 1);
    const token = new URL(links[0]!).searchParams.get('$skiptoken')!;
    await errorOf('/v1/odata/Messages', { $skiptoken: token, $orderby: 'createdAt' }); // a keyset token with $orderby
    const key = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/'))) as { k: string };
    expect(key.k).toBe('msg_01000');
  });

  it('answers 400 for a forged skiptoken the database would refuse', async () => {
    const forged = (value: unknown) => btoa(JSON.stringify(value));
    const invalid = { code: 'BadRequest', message: 'Invalid $skiptoken' };
    // An offset above what OFFSET takes, negative, fractional or not a number.
    for (const o of [2147483648, 123456789012, 9007199254740992, -1, 1.5, '5', null, true]) {
      const error = await errorOf('/v1/odata/Messages', { $skiptoken: forged({ o }), $orderby: 'id' });
      expect(error, JSON.stringify(o)).toEqual(invalid);
    }
    // A key that is not a string, or one with a NUL character in it.
    for (const k of [5, null, ['a'], { a: 1 }, 'msg_\u0000', '\u0000']) {
      const error = await errorOf('/v1/odata/Messages', { $skiptoken: forged({ k }) });
      expect(error, JSON.stringify(k)).toEqual(invalid);
    }
    // The largest offset is still a position: nothing lies that far.
    const last = await get('/v1/odata/Messages', { $skiptoken: forged({ o: 2147483647 }), $orderby: 'id', $select: 'id' });
    expect(last.value).toEqual([]);
    expect(last['@odata.nextLink']).toBeUndefined();
  });
});

describe('errors, scope and headers', () => {
  it('answers an unknown set or path with 404, valid-but-unserved OData with 501', async () => {
    expect((await errorOf('/v1/odata/Nope', {}, 404)).code).toBe('NotFound');
    await errorOf('/v1/odata/Nope/$count', {}, 404);
    await errorOf("/v1/odata/Nope('x')", {}, 404);
    await errorOf('/v1/odata/conversations', {}, 404);
    await errorOf('/v1/odata/Conversations%2F', {}, 404);
    await errorOf('/v1/odata/%E0%A4%A', {}, 400);
    for (const option of ['$expand', '$apply', '$search', '$compute', '$levels']) {
      const error = await errorOf('/v1/odata/Conversations', { [option]: 'x' }, 501);
      expect(error.code, option).toBe('NotImplemented');
    }
    expect((await errorOf("/v1/odata/Conversations('cnv_1')/messages", {}, 501)).code).toBe('NotImplemented');
    await errorOf('/v1/odata/Conversations/messages', {}, 501);
    await errorOf('/v1/odata/$batch', {}, 404);
  });

  it('answers 400 for an unknown $ option, a repeated one, and an option the surface does not take', async () => {
    await errorOf('/v1/odata/Conversations', { $inlinecount: 'allpages' });
    const repeated = await app().request('/v1/odata/Conversations?$top=1&$top=2');
    expect(repeated.status).toBe(400);
    // an option that is not OData's own is ignored
    expect((await get('/v1/odata/Conversations', { custom: '1', $top: '1' })).value).toHaveLength(1);
  });

  it('answers a write with 405, Allow and the error shape', async () => {
    const { request } = appWith(['*']);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/v1/odata/Conversations', "/v1/odata/Conversations('cnv_1')", '/v1/odata']) {
        const res = await request(path, { method, body: method === 'DELETE' ? undefined : '{}' });
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MethodNotAllowed');
      }
    }
    expect((await app().request("/v1/odata/Conversations('cnv_1')")).status).toBe(200);
    expect(await (await app().request('/v1/odata/Conversations/$count')).text()).toBe('5');
  });

  it('needs the reports:read scope', async () => {
    const wrong = appWith(['audit_logs:read']);
    for (const path of ['/v1/odata', '/v1/odata/$metadata', '/v1/odata/Conversations', '/v1/odata/Conversations/$count', "/v1/odata/Teams('team_1')"]) {
      const res = await wrong.request(path);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    }
    for (const scopes of [['reports:read'], ['reports:*'], ['*']]) {
      expect((await appWith(scopes).request('/v1/odata/Teams')).status, scopes.join()).toBe(200);
    }
    expect((await appWith(['crm:*']).request('/v1/odata')).status).toBe(403);
    const anonymous = createExternalTestApp({ session: null, tenantDb: db });
    expect((await anonymous.request('/v1/odata/Teams')).status).toBe(401);
  });

  it('sets the OData headers', async () => {
    for (const path of ['/v1/odata', '/v1/odata/Teams', "/v1/odata/Teams('team_1')"]) {
      const res = await app().request(path);
      expect(res.headers.get('OData-Version'), path).toBe('4.0');
      expect(res.headers.get('Content-Type'), path).toBe('application/json;odata.metadata=minimal');
    }
    const failed = await app().request('/v1/odata/Nope');
    expect(failed.headers.get('OData-Version')).toBe('4.0');
    expect(failed.headers.get('Content-Type')).toBe('application/json;odata.metadata=minimal');
    const denied = await appWith(['crm:*']).request('/v1/odata/Teams');
    expect(denied.headers.get('OData-Version')).toBe('4.0');
    // A refusal repeats nothing it could be mistaken for, and is still not to be sniffed.
    expect(denied.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(failed.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('is listed on GET /v1', async () => {
    const res = await createExternalTestApp({ scopes: ['*'], tenantDb: db }).request('/v1');
    const body = (await res.json()) as { data: { endpoints: string[] } };
    expect(body.data.endpoints).toContain('/v1/odata');
  });
});
