/**
 * Parity fixtures for the Rust port of the inbound reply path
 * (`rust/modules/reach/src/inbound`), written by the TypeScript code itself.
 *
 * - `inbound_parse.json`: every `.eml` fixture of `email/__fixtures__` and a
 *   few more notices, through `parseInbound`, `classifyInbound`, the reply
 *   text, the opt-out rule and the threading ids.
 * - `inbound_deliveries.json`: whole deliveries (`deliverInbound`) on
 *   pglite, each scenario on its own seeded workspace, recording each
 *   delivery's result and entity events, the raw copies kept in `STORAGE`
 *   and the rows left behind (WeldReach's, and WeldCRM's people, companies,
 *   links and activities). The model is unavailable, as on the Kubernetes
 *   editions: a matched reply is labelled `unclassified`.
 *
 * `rust/modules/reach/tests/inbound_parity.rs` replays them.
 *
 *   pnpm rust:reach-inbound-fixtures     write the fixtures
 *   pnpm --filter reach-api test         fails when they are stale
 *
 * Generated ids become placeholders (`<rmsg:1>`) and times written by the
 * wall clock (database defaults, `new Date()`) become `<ts>`; seeded rows
 * have fixed ids and times.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import {
  reachCampaigns,
  reachEnrollments,
  reachMailboxes,
  reachMessages,
  reachProspects,
  reachSettings,
  reachSuppressions,
} from '@weldsuite/db/schema';
import type { Env } from '../types';
import { loadFixtureText } from '../email/__fixtures__/load';
import { FakeR2Bucket, resetTables, seedCampaign, seedEnrollment, seedMailbox, seedOutbound, seedProspect } from '../email/test-support';
import { threadingIdsOf } from '../email/handler';
import { parseInbound } from '../lib/inbound/mime';
import { classifyInbound } from '../lib/inbound/kind';
import { isUnsubscribeRequest } from '../lib/inbound/intent';
import { stripQuotedHistory } from '@weldsuite/reach-domain/inbound/text';
import { candidateMessageIds, deliverInbound } from '../services/inbound';
import type { SinkEvent } from '../services/realtime';

const OUT_DIR = path.resolve(import.meta.dirname, '../../../../../rust/modules/reach/tests/fixtures');
const WRITE = process.env.WRITE_RUST_FIXTURES === '1';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const ORG = 'org_reach_test';
const NOW = new Date('2026-10-12T14:41:00.000Z');

// ---------------------------------------------------------------------------
// Normalisation (mirrored in the Rust test)
// ---------------------------------------------------------------------------

/** `generateId`: a base-36 time and 8 random characters; seeded ids are shorter. */
const GENERATED_ID = /^([a-z]+)_[0-9a-z]{12,}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Seeded and fixed times are before this; the wall clock is after it. */
const WALL_CLOCK = '2026-10-20';
const RAW_KEY = /^reach\/([^/]+)\/([a-z]+_[0-9a-z]+)\.eml$/;

class Placeholders {
  private readonly ids = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  of(prefix: string, value: string): string {
    const known = this.ids.get(value);
    if (known) return known;
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const placeholder = `<${prefix}:${n}>`;
    this.ids.set(value, placeholder);
    return placeholder;
  }

  text(value: string): Json {
    const id = GENERATED_ID.exec(value);
    if (id) return this.of(id[1]!, value);
    const key = RAW_KEY.exec(value);
    if (key) return `reach/${key[1]}/${this.text(key[2]!) as string}.eml`;
    if (ISO.test(value)) return value >= WALL_CLOCK ? '<ts>' : new Date(value).toISOString();
    return value;
  }

  json(value: unknown): Json {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return this.text(value.toISOString());
    if (Array.isArray(value)) return value.map((v) => this.json(v));
    if (typeof value === 'object') {
      const out: Record<string, Json> = {};
      for (const k of Object.keys(value).sort()) {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) continue;
        out[k] = this.json(v);
      }
      return out;
    }
    if (typeof value === 'string') return this.text(value);
    return value as Json;
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const crlf = (lines: string[]) => lines.join('\r\n');

/** Notices and replies beyond the `.eml` fixtures, for the rules the fixtures do not reach. */
const EXTRA_MESSAGES: Record<string, string> = {
  'mailing-list.eml': crlf([
    'From: Newsletter <news@vendor.example>',
    'To: sam@getacme.com',
    'Subject: October offers',
    'Message-ID: <news-1@vendor.example>',
    'List-Unsubscribe: <https://vendor.example/unsub>',
    'Content-Type: text/plain',
    '',
    'Big savings.',
  ]),
  'unknown-unsubscribe.eml': crlf(['From: Anon <anon@somewhere.example>', 'To: sam@getacme.com', 'Subject: unsubscribe', 'Message-ID: <anon-1@somewhere.example>', '', '']),
  'own-mailbox.eml': crlf([
    'From: Sam Jansen <sam@getacme.com>',
    'To: sam@getacme.com',
    'Subject: Re: Quick question about Acme logistics',
    'Message-ID: <own-1@getacme.com>',
    'In-Reply-To: <out-1001@getacme.com>',
    '',
    'Looping back.',
  ]),
  'no-message-id.eml': crlf(['From: Jane Doe <jane@acme.nl>', 'To: sam@getacme.com', 'Subject: Re: Quick question', 'In-Reply-To: <out-1001@getacme.com>', '', 'Yes, call me Tuesday.']),
  'gmail-free-mail-reply.eml': crlf([
    'From: Ann <ann@gmail.com>',
    'To: sam@getacme.com',
    'Subject: Re: Quick question',
    'Message-ID: <free-1@mail.gmail.com>',
    'In-Reply-To: <out-5001@getacme.com>',
    'References: <out-0001@getacme.com> <out-5001@getacme.com>',
    '',
    'Interested, tell me more.',
  ]),
  'dsn-delivered.eml': crlf([
    'From: Mail Delivery System <MAILER-DAEMON@mx.acme.nl>',
    'To: sam@getacme.com',
    'Subject: Successful Mail Delivery Report',
    'Message-ID: <dsn-ok-1@mx.acme.nl>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain',
    '',
    'Your message was delivered.',
    '--b1',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.acme.nl',
    'X-Original-Message-ID: <out-1001@getacme.com>',
    '',
    'Final-Recipient: rfc822; jane@acme.nl',
    'Action: delivered',
    'Status: 2.0.0',
    '--b1--',
  ]),
  'read-receipt.eml': crlf([
    'From: Jane Doe <jane@acme.nl>',
    'To: sam@getacme.com',
    'Subject: Read: Quick question',
    'Message-ID: <mdn-1@acme.nl>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=disposition-notification; boundary="b2"',
    '',
    '--b2',
    'Content-Type: text/plain',
    '',
    'Your message was read.',
    '--b2',
    'Content-Type: message/disposition-notification',
    '',
    'Final-Recipient: rfc822; jane@acme.nl',
    'Disposition: manual-action/MDN-sent-manually; displayed',
    '--b2--',
  ]),
  'policy-bounce.eml': crlf([
    'From: postmaster@bigcorp.example',
    'To: sam@getacme.com',
    'Subject: Returned mail: see transcript',
    'Message-ID: <policy-1@bigcorp.example>',
    '',
    'The message was blocked by our spam policy (reputation).',
    'Message-ID: <out-6001@getacme.com>',
  ]),
  'postfix-text-bounce.eml': crlf([
    'From: MAILER-DAEMON@mx.example.org (Mail Delivery System)',
    'To: sam@getacme.com',
    'Subject: Undelivered Mail Returned to Sender',
    'Message-ID: <pf-1@mx.example.org>',
    '',
    'I\'m sorry to have to inform you that your message could not',
    'be delivered to one or more recipients.',
    '',
    '<Gone.User@Example.org>: host mx.example.org[192.0.2.1] said: 550 5.1.1',
    '    <gone.user@example.org>: Recipient address rejected: User unknown',
    '',
    '-----Original Message-----',
    'From: Sam <sam@getacme.com>',
    'To: Other Person <other@example.org>',
    'Message-ID: <out-7001@getacme.com>',
  ]),
  'outlook-text-bounce.eml': crlf([
    'From: Microsoft Outlook <postmaster@contoso.example>',
    'To: sam@getacme.com',
    'Subject: Undeliverable: Hello',
    'Message-ID: <ol-1@contoso.example>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your message to Bob@Contoso.example couldn’t be delivered.',
    'Bob wasn’t found at contoso.example.',
  ]),
  'delay-text.eml': crlf([
    'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    'To: sam@getacme.com',
    'Subject: Delivery Status Notification (Delay)',
    'Message-ID: <delay-text-1@mx.google.com>',
    '',
    'Delivery to the following recipient has been delayed:',
    '',
    '     slow@example.org',
    '',
    'Gmail will keep trying to deliver your message.',
  ]),
  'ooo-es.eml': crlf([
    'From: Ana <ana@ejemplo.es>',
    'To: sam@getacme.com',
    'Subject: =?UTF-8?Q?Respuesta_autom=C3=A1tica=3A_Hola?=',
    'Message-ID: <ooo-es-1@ejemplo.es>',
    '',
    'Estoy fuera de la oficina.',
  ]),
  'exchange-suppress.eml': crlf([
    'From: Kim <kim@acme.nl>',
    'To: sam@getacme.com',
    'Subject: Re: Quick question',
    'Message-ID: <kim-1@acme.nl>',
    'X-Auto-Response-Suppress: All',
    '',
    'Thanks!',
  ]),
  'html-only-reply.eml': crlf([
    'From: Jane Doe <jane@acme.nl>',
    'To: sam@getacme.com',
    'Subject: Re: Quick question',
    'Message-ID: <html-1@acme.nl>',
    'In-Reply-To: <out-1001@getacme.com>',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<div>Please remove me from your list.</div><blockquote>On Monday Sam wrote: hi</blockquote>',
  ]),
};

const EML_FIXTURES = [
  'gmail-reply.eml',
  'outlook-reply.eml',
  'reply-no-threading.eml',
  'ooo-en.eml',
  'ooo-nl.eml',
  'unsubscribe-reply.eml',
  'bounce-gmail-dsn.eml',
  'bounce-outlook-ndr.eml',
  'bounce-postfix-dsn.eml',
  'bounce-nondsn.eml',
  'bounce-delayed.eml',
];

/** A message's text as delivered (CRLF line ends). */
function messageText(name: string): string {
  return EXTRA_MESSAGES[name] ?? loadFixtureText(name);
}

const encode = (text: string) => new TextEncoder().encode(text);

async function parseCase(name: string) {
  const raw = messageText(name);
  const parsed = await parseInbound(encode(raw));
  const classification = classifyInbound(parsed);
  const replyText = stripQuotedHistory(parsed.text);
  const headers: Record<string, string> = {};
  for (const key of Object.keys(parsed.headers).sort()) headers[key] = parsed.headers[key]!;
  return {
    name,
    raw,
    expected: {
      parsed: { ...parsed, headers },
      classification,
      replyText,
      optOut: isUnsubscribeRequest(parsed.subject, replyText),
      threadingIds: threadingIdsOf(parsed),
      candidateIds: candidateMessageIds(parsed, classification.bounce),
    },
  };
}

// ---------------------------------------------------------------------------
// Delivery scenarios: fixed ids, so placeholders and row order are stable
// ---------------------------------------------------------------------------

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

const MAILBOX = 'rmbx_main';
const CAMPAIGN = 'rcmp_main';

/** A prospect with an active enrollment whose first email (`messageId`) is stored as sent. */
async function seedSent(key: string, email: string, messageId: string, extra: Partial<typeof reachProspects.$inferInsert> = {}, campaignId = CAMPAIGN) {
  await seedProspect(db, { id: `rpro_${key}`, email, ...extra });
  await seedEnrollment(db, {
    id: `renr_${key}`,
    campaignId,
    prospectId: `rpro_${key}`,
    mailboxId: MAILBOX,
    threadRootMessageId: messageId,
  });
  await seedOutbound(db, {
    id: `rmsg_out_${key}`,
    messageIdHeader: messageId,
    mailboxId: MAILBOX,
    campaignId,
    enrollmentId: `renr_${key}`,
    prospectId: `rpro_${key}`,
    toEmail: email,
  });
}

interface Scenario {
  name: string;
  seed?: () => Promise<void>;
  /** Message names, delivered in order. */
  deliveries: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a Gmail reply stops the sequence, completes the campaign and reaches the CRM',
    seed: () => seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com', { firstName: 'Jane', lastName: 'Doe', companyName: 'Acme BV' }),
    deliveries: ['gmail-reply.eml'],
  },
  {
    name: 'an existing CRM company by website and an existing person by email',
    async seed() {
      await seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com', { firstName: 'Jane', companyName: 'Something Else' });
      await db.insert(schema.companies).values({ id: 'cmp_existing', name: 'Acme Logistics', displayName: 'Acme Logistics', website: 'https://www.acme.nl/about' });
      await db.insert(schema.people).values({ id: 'per_existing', email: 'JANE@acme.nl', firstName: 'Jane', displayName: 'Jane', inCrm: false });
    },
    deliveries: ['gmail-reply.eml'],
  },
  {
    name: 'the campaign owner still a member owns the CRM records',
    async seed() {
      await db.insert(schema.workspaceMembers).values({ id: 'wm_owner', userId: 'user_owner', role: 'MEMBER' });
      await db.update(reachCampaigns).set({ ownerId: 'user_owner' }).where(sql`${reachCampaigns.id} = ${CAMPAIGN}`);
      await seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com', { firstName: 'Jane', companyName: 'Acme BV' });
    },
    deliveries: ['gmail-reply.eml'],
  },
  {
    name: 'a campaign owner who left: the system assignee',
    async seed() {
      await db.update(reachCampaigns).set({ ownerId: 'user_gone' }).where(sql`${reachCampaigns.id} = ${CAMPAIGN}`);
      await seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com');
    },
    deliveries: ['gmail-reply.eml'],
  },
  {
    name: 'a duplicate delivery is stored and counted once',
    seed: () => seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com'),
    deliveries: ['gmail-reply.eml', 'gmail-reply.eml'],
  },
  {
    name: 'an Outlook reply with prospect scope',
    async seed() {
      await seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com');
      await seedSent('pieter', 'pieter@acme.nl', 'out-2001@getacme.com');
    },
    deliveries: ['outlook-reply.eml'],
  },
  {
    name: 'an Outlook reply with company scope, and the prospect in another campaign',
    async seed() {
      await db.insert(reachSettings).values({ id: 'rset_1', stopOnReplyScope: 'company' });
      await seedCampaign(db, { id: 'rcmp_other', name: 'Other' });
      await seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com');
      await seedSent('pieter', 'pieter@acme.nl', 'out-2001@getacme.com');
      await seedEnrollment(db, { id: 'renr_pieter_other', campaignId: 'rcmp_other', prospectId: 'rpro_pieter', mailboxId: MAILBOX });
    },
    deliveries: ['outlook-reply.eml'],
  },
  {
    name: 'company scope never fans out over a free-mail domain',
    async seed() {
      await db.insert(reachSettings).values({ id: 'rset_1', stopOnReplyScope: 'company' });
      await seedSent('ann', 'ann@gmail.com', 'out-5001@getacme.com');
      await seedSent('bob', 'bob@gmail.com', 'out-5002@getacme.com');
    },
    deliveries: ['gmail-free-mail-reply.eml'],
  },
  {
    name: 'a reply without threading headers is matched by sender',
    async seed() {
      await seedProspect(db, { id: 'rpro_lisa', email: 'lisa@bluesky.io', firstName: 'Lisa' });
      await seedEnrollment(db, { id: 'renr_lisa', campaignId: CAMPAIGN, prospectId: 'rpro_lisa', mailboxId: MAILBOX, threadRootMessageId: 'out-4001@getacme.com' });
    },
    deliveries: ['reply-no-threading.eml'],
  },
  {
    name: 'matched by sender: the enrollment on this mailbox, not another',
    async seed() {
      await seedMailbox(db, { id: 'rmbx_other', email: 'kim@getacme.com', inboundToken: 'othertoken0001' });
      await seedProspect(db, { id: 'rpro_lisa', email: 'lisa@bluesky.io' });
      await seedEnrollment(db, { id: 'renr_lisa_here', campaignId: CAMPAIGN, prospectId: 'rpro_lisa', mailboxId: MAILBOX, threadRootMessageId: 'out-4001@getacme.com' });
      await seedCampaign(db, { id: 'rcmp_other', name: 'Other' });
      await seedEnrollment(db, { id: 'renr_lisa_there', campaignId: 'rcmp_other', prospectId: 'rpro_lisa', mailboxId: 'rmbx_other', threadRootMessageId: 'out-4002@getacme.com' });
    },
    deliveries: ['reply-no-threading.eml'],
  },
  { name: 'a sender nobody knows', deliveries: ['reply-no-threading.eml'] },
  { name: 'mailing-list mail that answers nothing', deliveries: ['mailing-list.eml'] },
  {
    name: 'an English out-of-office',
    seed: () => seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com'),
    deliveries: ['ooo-en.eml'],
  },
  {
    name: 'a Dutch out-of-office',
    seed: () => seedSent('tom', 'tom@redwood.eu', 'out-1010@getacme.com'),
    deliveries: ['ooo-nl.eml'],
  },
  {
    name: 'a campaign that stops on auto-replies',
    async seed() {
      await db.update(reachCampaigns).set({ stopOnAutoReply: true }).where(sql`${reachCampaigns.id} = ${CAMPAIGN}`);
      await seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com');
    },
    deliveries: ['ooo-en.eml'],
  },
  {
    name: 'an "Unsubscribe" reply',
    seed: () => seedSent('tom', 'tom@redwood.eu', 'out-1010@getacme.com'),
    deliveries: ['unsubscribe-reply.eml'],
  },
  { name: 'an unknown sender who asks to be removed', deliveries: ['unknown-unsubscribe.eml'] },
  {
    name: 'an opt-out written in HTML only',
    seed: () => seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com'),
    deliveries: ['html-only-reply.eml'],
  },
  {
    name: 'a Gmail DSN',
    seed: () => seedSent('nobody', 'nobody@acme.nl', 'out-3001@getacme.com'),
    deliveries: ['bounce-gmail-dsn.eml'],
  },
  {
    name: 'an Outlook / Exchange NDR',
    seed: () => seedSent('former', 'former.employee@bluesky.io', 'out-3002@getacme.com'),
    deliveries: ['bounce-outlook-ndr.eml'],
  },
  {
    name: 'a Postfix DSN with headers only',
    seed: () => seedSent('gone', 'gone@oldco.example', 'out-3003@getacme.com'),
    deliveries: ['bounce-postfix-dsn.eml'],
  },
  {
    name: 'a plain-text Mail Delivery Subsystem notice',
    seed: () => seedSent('missing', 'missing.person@example.org', 'out-3004@getacme.com'),
    deliveries: ['bounce-nondsn.eml'],
  },
  {
    name: 'a bounce matched by its failed recipient',
    seed: () => seedSent('nobody', 'nobody@acme.nl', 'out-different@getacme.com'),
    deliveries: ['bounce-gmail-dsn.eml'],
  },
  {
    name: 'a delay notice',
    seed: () => seedSent('slow', 'slow@example.org', 'out-3005@getacme.com'),
    deliveries: ['bounce-delayed.eml'],
  },
  {
    name: 'a policy bounce suppresses nobody',
    seed: () => seedSent('policy', 'ceo@bigcorp.example', 'out-6001@getacme.com'),
    deliveries: ['policy-bounce.eml'],
  },
  {
    name: 'a bounce delivered twice is counted once',
    seed: () => seedSent('nobody', 'nobody@acme.nl', 'out-3001@getacme.com'),
    deliveries: ['bounce-gmail-dsn.eml', 'bounce-gmail-dsn.eml'],
  },
  {
    name: 'five hard bounces pause the mailbox',
    async seed() {
      for (const n of [1, 2, 3, 4]) {
        await seedProspect(db, { id: `rpro_gone${n}`, email: `gone${n}@oldco.example` });
        await seedEnrollment(db, { id: `renr_gone${n}`, campaignId: CAMPAIGN, prospectId: `rpro_gone${n}`, mailboxId: MAILBOX, status: 'bounced' });
      }
      await seedSent('nobody', 'nobody@acme.nl', 'out-3001@getacme.com');
    },
    deliveries: ['bounce-gmail-dsn.eml'],
  },
  {
    name: 'mail from one of our own mailboxes',
    seed: () => seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com'),
    deliveries: ['own-mailbox.eml'],
  },
  {
    name: 'a reply without a Message-ID',
    seed: () => seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com'),
    deliveries: ['no-message-id.eml', 'no-message-id.eml'],
  },
  {
    name: 'a reply never touches an enrollment that already ended',
    async seed() {
      await seedSent('jane', 'jane@acme.nl', 'out-1001@getacme.com');
      await db.update(reachEnrollments).set({ status: 'unsubscribed', stoppedReason: 'unsubscribed', nextSendAt: null }).where(sql`${reachEnrollments.id} = 'renr_jane'`);
    },
    deliveries: ['gmail-reply.eml'],
  },
];

/** The CRM rows a delivery may write, projected the same way on both sides. */
const CRM_QUERIES: Record<string, string> = {
  companies:
    "select json_build_object('id', id, 'name', name, 'displayName', display_name, 'website', website, 'source', source, 'ownerId', owner_id) as row from companies order by name, id",
  crm_activities:
    "select json_build_object('id', id, 'type', type, 'subject', subject, 'description', description, 'personId', person_id, 'customerId', customer_id, 'emailMessageId', email_message_id, 'emailSubject', email_subject, 'emailFrom', email_from, 'emailTo', email_to, 'status', status, 'priority', priority, 'assignedToId', assigned_to_id) as row from crm_activities order by email_message_id, id",
  people:
    "select json_build_object('id', id, 'email', email, 'firstName', first_name, 'lastName', last_name, 'fullName', full_name, 'displayName', display_name, 'title', title, 'source', source, 'inCrm', in_crm, 'ownerId', owner_id) as row from people order by email, id",
  person_companies:
    "select json_build_object('personId', person_id, 'companyId', company_id, 'isPrimary', is_primary) as row from person_companies",
};

const SEED_TABLES = [
  'reach_settings',
  'reach_mailboxes',
  'reach_campaigns',
  'reach_prospects',
  'reach_enrollments',
  'reach_messages',
  'reach_suppressions',
  'workspace_members',
  'companies',
  'people',
];

async function rawRows(query: string): Promise<unknown[]> {
  const result = await db.execute(sql.raw(query));
  return (result as unknown as { rows: Array<{ row: unknown }> }).rows.map((r) => r.row);
}

/** The seeded rows as Postgres has them (`to_jsonb`), for the Rust side to insert. */
async function rawSeed(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of SEED_TABLES) out[table] = await rawRows(`select to_jsonb(t) as row from ${table} t order by t.id`);
  return out;
}

/** Every row a delivery may touch: WeldReach's as Drizzle reads them, WeldCRM's projected. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const byKey = <T>(key: (row: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const rows: Record<string, unknown[]> = {};
  for (const [table, query] of Object.entries(CRM_QUERIES)) rows[table] = await rawRows(query);
  rows.reach_campaigns = (await db.select().from(reachCampaigns)).sort(byKey((r) => r.id));
  rows.reach_enrollments = (await db.select().from(reachEnrollments)).sort(byKey((r) => r.id));
  rows.reach_mailboxes = (await db.select().from(reachMailboxes)).sort(byKey((r) => r.id));
  rows.reach_messages = (await db.select().from(reachMessages)).sort(byKey((r) => r.messageIdHeader));
  rows.reach_prospects = (await db.select().from(reachProspects)).sort(byKey((r) => r.id));
  rows.reach_suppressions = (await db.select().from(reachSuppressions)).sort(byKey((r) => r.value));
  return rows;
}

async function runScenario(s: Scenario) {
  await resetTables(db);
  await seedMailbox(db, { id: MAILBOX });
  await seedCampaign(db, { id: CAMPAIGN });
  await s.seed?.();
  const seed = await rawSeed();
  const bucket = new FakeR2Bucket();
  const env = { ENVIRONMENT: 'test', REACH_INBOUND_DOMAIN: 'reply-test.weldreach.com', STORAGE: bucket.asBucket() } as unknown as Env;
  const mailbox = { id: MAILBOX, email: 'sam@getacme.com' };

  const deliveries: Array<{ result: unknown; events: unknown[] }> = [];
  for (const name of s.deliveries) {
    const events: SinkEvent[] = [];
    const pending: Promise<unknown>[] = [];
    const result = await deliverInbound({
      env,
      db,
      clerkOrgId: ORG,
      mailbox,
      raw: encode(messageText(name)),
      waitUntil: (promise) => pending.push(promise),
      now: () => NOW,
      sink: (event) => {
        events.push(event);
      },
      // The Kubernetes editions have no model: the outcome reach-api records without one.
      classify: async () => ({ ok: false, reason: 'not_configured' }),
    });
    await Promise.all(pending);
    deliveries.push({
      result,
      events: events
        .map((e) => ({ event: `${e.entityType}:${e.action}`, entityId: e.entityId, data: e.data, changes: e.changes ?? null }))
        .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0)),
    });
  }

  const p = new Placeholders();
  const expected = p.json({ deliveries, rows: await snapshot(), storage: [...bucket.objects.keys()] }) as {
    rows: Record<string, Array<Record<string, Json>>>;
    storage: string[];
  };
  // Link rows carry only ids placeholdered already: sort them by those.
  const link = (r: Record<string, Json>) => `${String(r.personId)}|${String(r.companyId)}`;
  expected.rows.person_companies!.sort((a, b) => (link(a) < link(b) ? -1 : link(a) > link(b) ? 1 : 0));
  expected.storage.sort();
  return { name: s.name, messages: s.deliveries.map((name) => ({ name, raw: messageText(name) })), seed, expected };
}

// ---------------------------------------------------------------------------

function writeOrCheck(name: string, value: unknown): void {
  const file = path.join(OUT_DIR, `${name}.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (WRITE) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  if (!existsSync(file)) return;
  const stored = JSON.parse(readFileSync(file, 'utf8')) as { cases: Array<{ name: string; expected: unknown }> };
  const fresh = JSON.parse(text) as typeof stored;
  // Seeds carry wall-clock defaults: compare what the code did.
  expect(fresh.cases.map((c) => [c.name, c.expected])).toEqual(stored.cases.map((c) => [c.name, c.expected]));
}

describe('Rust parity fixtures (pnpm rust:reach-inbound-fixtures)', () => {
  it('parsing and classifying messages', async () => {
    const cases = [];
    for (const name of [...EML_FIXTURES, ...Object.keys(EXTRA_MESSAGES)]) cases.push(await parseCase(name));
    writeOrCheck('inbound_parse', { cases });
  });

  it('whole deliveries', async () => {
    const cases = [];
    for (const s of SCENARIOS) cases.push(await runScenario(s));
    writeOrCheck('inbound_deliveries', { org: ORG, now: NOW.toISOString(), mailbox: { id: MAILBOX, email: 'sam@getacme.com' }, crmQueries: CRM_QUERIES, cases });
  }, 180_000);
});
