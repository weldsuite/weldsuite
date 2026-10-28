/**
 * Tenant DB readers. Every query runs inside the caller's READ ONLY
 * transaction (see `auditTenant` in index.ts) and only SELECTs.
 *
 * Timestamps in the tenant DB are `timestamp without time zone` holding UTC.
 * They are read back `AT TIME ZONE 'UTC'` so the driver builds correct Dates
 * whatever the local time zone, and window bounds are passed the same way.
 */

import type postgres from 'postgres';
import { isEmailAddress, parseAddressList } from './recipients';
import type { EnrollmentRow, MailboxInfo, SentMessageRow, SequenceStepRow, WorkflowStepGroup } from './types';

type Tx = postgres.TransactionSql;

export interface Window {
  since: Date;
  until: Date;
}

export const AUDITED_TABLES = [
  'mail_messages',
  'mail_accounts',
  'mail_domains',
  'mail_correspondents',
  'sequence_enrollments',
  'workflow_executions',
  'workflow_execution_steps',
] as const;
export type AuditedTable = (typeof AUDITED_TABLES)[number];

const CURSOR_ROWS = 500;
const LOOKUP_CHUNK = 20_000;
/** Bodies are cut before they leave the database: the fingerprint keeps 4,000 normalised characters. */
const TEXT_BODY_CHARS = 10_000;
const HTML_BODY_CHARS = 30_000;

export async function existingTables(tx: Tx): Promise<Set<AuditedTable>> {
  const rows = await tx<{ name: string }[]>`
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${tx.array([...AUDITED_TABLES])}::text[])`;
  const known = new Set<string>(AUDITED_TABLES);
  const found = new Set<AuditedTable>();
  for (const row of rows) if (known.has(row.name)) found.add(row.name as AuditedTable);
  return found;
}

export async function loadMailboxes(tx: Tx): Promise<Map<string, MailboxInfo>> {
  const rows = await tx<MailboxInfo[]>`
    SELECT id,
           lower(btrim(email)) AS email,
           coalesce(send_provider, provider::text) AS "sendProvider",
           (deleted_at IS NOT NULL) AS deleted
    FROM mail_accounts`;
  return new Map(rows.map((row) => [row.id, { ...row }]));
}

export interface MailDomainRow {
  domain: string;
  zoneId: string | null;
}

export async function loadMailDomains(tx: Tx): Promise<MailDomainRow[]> {
  const rows = await tx<MailDomainRow[]>`
    SELECT lower(btrim(domain_name)) AS domain, cloudflare_zone_id AS "zoneId"
    FROM mail_domains
    WHERE deleted_at IS NULL`;
  return rows.map((row) => ({ ...row }));
}

/**
 * SENT copies that went out in the window (scheduled, cancelled and failed
 * scheduled sends excluded). `excludeAccountIds` leaves out mailboxes this
 * tool is reading through the mail-store export client instead (design doc
 * §9 task E2): their `mail_messages` row may be a lagging secondary
 * (`object` mode) or never written at all (`object-only`), so including them
 * here would double-count or silently miss their sends.
 */
function sentFilter(tx: Tx, window: Window, excludeAccountIds: readonly string[] = []) {
  return tx`m.source = 'sent'
    AND m.sent_date >= (${window.since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    AND m.sent_date <= (${window.until.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    AND (m.send_status IS NULL OR m.send_status NOT IN ('scheduled', 'cancelled', 'failed'))
    AND coalesce(m.is_draft, false) = false
    ${excludeAccountIds.length > 0 ? tx`AND m.account_id <> ALL(${tx.array([...excludeAccountIds])}::text[])` : tx``}`;
}

/** Every recipient address of the window's sends, parsed exactly as the aggregation parses them. */
export async function collectSentRecipients(
  tx: Tx,
  window: Window,
  into: Set<string>,
  excludeAccountIds: readonly string[] = [],
): Promise<void> {
  await tx<{ to: unknown; cc: unknown; bcc: unknown }[]>`
    SELECT m."to" AS "to", m.cc AS cc, m.bcc AS bcc
    FROM mail_messages m
    WHERE ${sentFilter(tx, window, excludeAccountIds)}`.cursor(CURSOR_ROWS * 4, (rows) => {
    for (const row of rows) {
      for (const field of [row.to, row.cc, row.bcc]) for (const entry of parseAddressList(field)) into.add(entry.email);
    }
  });
}

/**
 * When each address first wrote to the workspace: from `mail_correspondents`
 * when the table exists (kept by a trigger since the outbound-guard
 * migration), else from received mail itself (the same rule the migration's
 * backfill uses: any `mail_messages` row that is not a SENT copy).
 */
export async function loadFirstInbound(tx: Tx, emails: string[], useCorrespondents: boolean): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  for (let i = 0; i < emails.length; i += LOOKUP_CHUNK) {
    const chunk = tx.array(emails.slice(i, i + LOOKUP_CHUNK));
    const rows = useCorrespondents
      ? await tx<{ email: string; firstInboundAt: Date }[]>`
          SELECT c.email, (c.first_inbound_at AT TIME ZONE 'UTC') AS "firstInboundAt"
          FROM mail_correspondents c
          WHERE c.first_inbound_at IS NOT NULL AND c.email = ANY(${chunk}::text[])`
      : await tx<{ email: string; firstInboundAt: Date }[]>`
          SELECT r.email, (min(coalesce(i.received_date, i.sent_date)) AT TIME ZONE 'UTC') AS "firstInboundAt"
          FROM unnest(${chunk}::text[]) AS r(email)
          JOIN mail_messages i ON lower(btrim(i."from"->>'email')) = r.email
          WHERE i.source IS DISTINCT FROM 'sent' AND jsonb_typeof(i."from") = 'object'
          GROUP BY r.email`;
    for (const row of rows) result.set(row.email, row.firstInboundAt);
  }
  return result;
}

export async function streamSentMessages(
  tx: Tx,
  window: Window,
  onRow: (row: SentMessageRow) => void,
  excludeAccountIds: readonly string[] = [],
): Promise<void> {
  await tx<SentMessageRow[]>`
    SELECT m.id,
           m.account_id AS "accountId",
           (m.sent_date AT TIME ZONE 'UTC') AS "sentAt",
           m.subject,
           m."to" AS "to",
           m.cc AS cc,
           m.bcc AS bcc,
           m.in_reply_to AS "inReplyTo",
           m.is_reply AS "isReply",
           m.is_forwarded AS "isForwarded",
           left(m.text_body, ${TEXT_BODY_CHARS}::int) AS "textBody",
           left(m.html_body, ${HTML_BODY_CHARS}::int) AS "htmlBody"
    FROM mail_messages m
    WHERE ${sentFilter(tx, window, excludeAccountIds)}
    ORDER BY m.sent_date, m.id`.cursor(CURSOR_ROWS, (rows) => {
    for (const row of rows) onRow(row);
  });
}

/** `send_email` steps of CRM sequence runs, with the enrolled contact's address. */
export async function loadSequenceSteps(tx: Tx, window: Window): Promise<SequenceStepRow[]> {
  const rows = await tx<{ at: Date; status: string; sequenceId: string; recipient: string | null }[]>`
    SELECT (coalesce(s.completed_at, s.started_at, s.created_at) AT TIME ZONE 'UTC') AS at,
           s.status,
           e.workflow_id AS "sequenceId",
           lower(btrim(en.customer_snapshot->>'email')) AS recipient
    FROM workflow_execution_steps s
    JOIN workflow_executions e ON e.id = s.execution_id
    LEFT JOIN sequence_enrollments en ON en.id = e.trigger_data->>'enrollmentId'
    WHERE s.step_type = 'send_email'
      AND s.created_at >= (${window.since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND s.created_at <= (${window.until.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND e.trigger_data->>'source' = 'sequence_enrollment'`;
  return rows.map((row) => ({
    at: row.at,
    status: row.status,
    sequenceId: row.sequenceId,
    recipient: row.recipient && isEmailAddress(row.recipient) ? row.recipient : null,
  }));
}

export async function loadEnrollments(tx: Tx, window: Window): Promise<EnrollmentRow[]> {
  const rows = await tx<EnrollmentRow[]>`
    SELECT to_char(en.enrolled_at, 'YYYY-MM-DD') AS day, en.sequence_id AS "sequenceId", count(*)::int AS count
    FROM sequence_enrollments en
    WHERE en.enrolled_at >= (${window.since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND en.enrolled_at <= (${window.until.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1, 2`;
  return rows.map((row) => ({ ...row }));
}

/**
 * WeldConnect `send_email` steps (every workflow run that is not a CRM
 * sequence; editor test runs excluded), grouped. Error messages are reduced
 * to the "X of N" of a loop summary in SQL, so no address in a step error
 * ("Recipient address … is not valid") ever leaves the database.
 */
export async function loadWorkflowSendGroups(tx: Tx, window: Window): Promise<WorkflowStepGroup[]> {
  const rows = await tx<WorkflowStepGroup[]>`
    SELECT to_char(coalesce(s.completed_at, s.started_at, s.created_at), 'YYYY-MM-DD') AS day,
           s.status,
           e.workflow_id AS "workflowId",
           CASE WHEN jsonb_typeof(s.output -> 'runs') = 'number' THEN (s.output ->> 'runs')::numeric::int END AS runs,
           substring(s.error ->> 'message' from '^([0-9]+ of [0-9]+) runs failed') AS "runFailure",
           count(*)::int AS steps
    FROM workflow_execution_steps s
    JOIN workflow_executions e ON e.id = s.execution_id
    WHERE s.step_type = 'send_email'
      AND s.created_at >= (${window.since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND s.created_at <= (${window.until.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND (e.trigger_data ->> 'source') IS DISTINCT FROM 'sequence_enrollment'
      AND coalesce(e.execution_context ->> 'isTest', 'false') <> 'true'
    GROUP BY 1, 2, 3, 4, 5`;
  return rows.map((row) => ({ ...row }));
}
