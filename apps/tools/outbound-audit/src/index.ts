#!/usr/bin/env node
/**
 * WeldMail outbound audit: "is anyone sending cold email through WeldSuite
 * right now?" (docs/plans/weldmail-outbound-abuse.md, Phase 1).
 *
 * READ-ONLY. Every tenant query runs in a READ ONLY transaction; the master DB
 * is only SELECTed; Cloudflare is only queried for analytics. Run per
 * environment by staff; see README.md. The output holds customer data.
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { isSharedWeldMailDomain } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { ArgsError, USAGE, markdownTarget, parseArgs, type CliOptions } from './args';
import { assembleWorkspace, rankWorkspaces } from './assemble';
import { summarizeSequences, summarizeWorkflowSends } from './automation';
import { CLOUDFLARE_MAX_DAYS, CloudflareAnalytics, summarizeCloudflare, type SendingDomain } from './cloudflare';
import { estimateTrustLevel } from './limits';
import { MailAccumulator } from './mail-aggregate';
import { listWorkspaces, tenantDatabaseUrl, trustFactsOf, type WorkspaceRow } from './master';
import { domainOf } from './recipients';
import { redactReport } from './redact';
import { PRIVACY_NOTICE, renderJson, renderMarkdown } from './report';
import {
  collectSentRecipients,
  existingTables,
  loadEnrollments,
  loadFirstInbound,
  loadMailboxes,
  loadMailDomains,
  loadSequenceSteps,
  loadWorkflowSendGroups,
  streamSentMessages,
  type AuditedTable,
  type MailDomainRow,
  type Window,
} from './tenant-queries';
import type {
  AuditReport,
  CloudflareSummary,
  CorrespondentContext,
  MailboxInfo,
  MailSummary,
  SequenceStepRow,
  SequenceSummary,
  WorkflowSummary,
  WorkspaceAudit,
} from './types';

const DAY_MS = 86_400_000;
/** Templates and domains kept per workspace in the JSON at least (the markdown shows `--top`). */
const JSON_LIST_SIZE = 20;

type Tx = postgres.TransactionSql;

/** A setup problem worth one line on stderr and exit code 1. */
class ConfigError extends Error {}

function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Driver errors quote connection strings and hosts; never print them. */
function sanitize(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '<connection-string>')
    .replace(/\b[\w.-]+\.neon\.tech\b/gi, '<neon-host>');
}

function errorMessage(err: unknown): string {
  return sanitize(err instanceof Error ? err.message : String(err)).slice(0, 300);
}

// ---------------------------------------------------------------------------
// One tenant database
// ---------------------------------------------------------------------------

interface TableFlags {
  hasMail: boolean;
  hasDomains: boolean;
  hasWorkflows: boolean;
  hasSequences: boolean;
  useCorrespondents: boolean;
}

function tableFlags(tables: Set<AuditedTable>): TableFlags {
  const hasWorkflows = tables.has('workflow_executions') && tables.has('workflow_execution_steps');
  return {
    hasMail: tables.has('mail_messages') && tables.has('mail_accounts'),
    hasDomains: tables.has('mail_domains'),
    hasWorkflows,
    hasSequences: hasWorkflows && tables.has('sequence_enrollments'),
    useCorrespondents: tables.has('mail_correspondents'),
  };
}

function notesFor(flags: TableFlags): string[] {
  const notes: string[] = [];
  if (!flags.hasMail) notes.push('No WeldMail tables in this database.');
  if (!flags.hasSequences) notes.push('CRM sequence tables not found.');
  if (!flags.hasWorkflows) notes.push('Workflow run tables not found.');
  if (flags.hasMail && !flags.useCorrespondents) {
    notes.push('mail_correspondents not migrated yet: first contact computed from received mail in mail_messages.');
  }
  return notes;
}

interface TenantContext {
  ctx: CorrespondentContext;
  mailboxes: Map<string, MailboxInfo>;
  mailDomains: MailDomainRow[];
}

/** Mailboxes, own domains and, for every recipient of the window, when they first wrote in. */
async function loadContext(tx: Tx, window: Window, flags: TableFlags, sequenceSteps: SequenceStepRow[]): Promise<TenantContext> {
  const mailboxes = flags.hasMail ? await loadMailboxes(tx) : new Map<string, MailboxInfo>();
  const mailDomains = flags.hasDomains ? await loadMailDomains(tx) : [];

  const recipients = new Set<string>();
  if (flags.hasMail) await collectSentRecipients(tx, window, recipients);
  for (const step of sequenceSteps) if (step.recipient) recipients.add(step.recipient);
  const canLookUp = flags.hasMail && recipients.size > 0;
  const firstInbound = canLookUp ? await loadFirstInbound(tx, [...recipients], flags.useCorrespondents) : new Map<string, Date>();

  return {
    ctx: {
      firstInbound,
      ownAddresses: new Set([...mailboxes.values()].map((m) => m.email)),
      ownDomains: new Set(mailDomains.map((d) => d.domain).filter((d) => !isSharedWeldMailDomain(d))),
    },
    mailboxes,
    mailDomains,
  };
}

async function summarizeMail(tx: Tx, window: Window, context: TenantContext, listSize: number): Promise<MailSummary> {
  const acc = new MailAccumulator(context.ctx, context.mailboxes, { topTemplates: listSize, topDomains: listSize });
  await streamSentMessages(tx, window, (row) => acc.add(row));
  return acc.finish();
}

/** The workspace's mail domains plus the domains of mailboxes that sent: where Cloudflare data may be. */
function sendingDomainsOf(mailDomains: MailDomainRow[], mail: MailSummary | null): SendingDomain[] {
  const domains = new Map<string, SendingDomain>();
  for (const d of mailDomains) domains.set(d.domain, { domain: d.domain, zoneId: d.zoneId });
  for (const m of mail?.mailboxes ?? []) {
    const domain = domainOf(m.mailbox);
    if (domain && !domains.has(domain)) domains.set(domain, { domain, zoneId: null });
  }
  return [...domains.values()];
}

interface TenantData {
  mail: MailSummary | null;
  sequences: SequenceSummary | null;
  workflows: WorkflowSummary | null;
  sendingDomains: SendingDomain[];
  notes: string[];
}

async function readTenant(tx: Tx, window: Window, listSize: number): Promise<TenantData> {
  await tx`SET LOCAL statement_timeout = '300s'`;
  const flags = tableFlags(await existingTables(tx));
  const sequenceSteps = flags.hasSequences ? await loadSequenceSteps(tx, window) : [];
  const enrollments = flags.hasSequences ? await loadEnrollments(tx, window) : [];
  const context = await loadContext(tx, window, flags, sequenceSteps);

  const mail = flags.hasMail ? await summarizeMail(tx, window, context, listSize) : null;
  const sequences = flags.hasSequences ? summarizeSequences(sequenceSteps, enrollments, context.ctx, listSize) : null;
  const workflows = flags.hasWorkflows ? summarizeWorkflowSends(await loadWorkflowSendGroups(tx, window)) : null;

  return { mail, sequences, workflows, sendingDomains: sendingDomainsOf(context.mailDomains, mail), notes: notesFor(flags) };
}

async function auditTenant(databaseUrl: string, window: Window, listSize: number): Promise<TenantData> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 30, idle_timeout: 5 });
  try {
    return await sql.begin('read only', (tx) => readTenant(tx, window, listSize));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface RunContext {
  options: CliOptions;
  now: Date;
  window: Window;
  cloudflare: CloudflareAnalytics | null;
}

function cloudflareFromEnv(options: CliOptions, now: Date): CloudflareAnalytics | null {
  if (!options.cloudflare) return null;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new ConfigError('--cloudflare needs CLOUDFLARE_API_TOKEN (Account Analytics Read + Zone Read).');
  if (options.days > CLOUDFLARE_MAX_DAYS) {
    progress(`Cloudflare keeps ${CLOUDFLARE_MAX_DAYS} days of Email Sending analytics: that section covers the last ${CLOUDFLARE_MAX_DAYS} days.`);
  }
  return new CloudflareAnalytics(token, Math.min(options.days, CLOUDFLARE_MAX_DAYS), now);
}

async function loadWorkspaces(filter: string | null): Promise<WorkspaceRow[]> {
  const masterUrl = process.env.MASTER_DATABASE_URL;
  if (!masterUrl) throw new ConfigError('MASTER_DATABASE_URL is required (see README.md).');
  const master = postgres(masterUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await master.begin('read only', (tx) => listWorkspaces(tx, filter));
  } finally {
    await master.end({ timeout: 5 });
  }
}

async function cloudflareSummary(cloudflare: CloudflareAnalytics | null, domains: SendingDomain[]): Promise<CloudflareSummary | null> {
  if (!cloudflare) return null;
  if (domains.length === 0) return summarizeCloudflare([], cloudflare.windowDays, []);
  return cloudflare.summarize(domains);
}

async function auditWorkspace(row: WorkspaceRow, run: RunContext): Promise<WorkspaceAudit> {
  const databaseUrl = await tenantDatabaseUrl(row, process.env);
  if (!databaseUrl) throw new Error('incomplete Neon metadata');
  const data = await auditTenant(databaseUrl, run.window, Math.max(run.options.top, JSON_LIST_SIZE));
  return assembleWorkspace({
    workspace: row,
    trustLevel: estimateTrustLevel(trustFactsOf(row), run.now),
    mail: data.mail,
    sequences: data.sequences,
    workflows: data.workflows,
    cloudflare: await cloudflareSummary(run.cloudflare, data.sendingDomains),
    notes: data.notes,
  });
}

async function auditAll(rows: WorkspaceRow[], run: RunContext): Promise<Pick<AuditReport, 'workspaces' | 'failed'>> {
  const audits: WorkspaceAudit[] = [];
  const failed: AuditReport['failed'] = [];
  for (const [index, row] of rows.entries()) {
    const label = run.options.redact ? `workspace #${index + 1}` : `${row.name} (${row.id})`;
    progress(`[${index + 1}/${rows.length}] ${label}`);
    try {
      audits.push(await auditWorkspace(row, run));
    } catch (err) {
      const message = errorMessage(err);
      progress(`  failed: ${message}`);
      failed.push({ workspace: label, error: message });
    }
  }
  return { workspaces: rankWorkspaces(audits), failed };
}

async function writeOutput(file: string, content: string): Promise<string> {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

async function writeReport(report: AuditReport, options: CliOptions): Promise<string[]> {
  const written: string[] = [];
  const target = markdownTarget(options);
  const markdown = renderMarkdown(report, { top: options.top });
  if (target === 'stdout') process.stdout.write(markdown);
  else if (target !== 'none') written.push(await writeOutput(target.file, markdown));
  if (options.json === '-') process.stdout.write(renderJson(report));
  else if (options.json) written.push(await writeOutput(options.json, renderJson(report)));
  return written;
}

async function run(options: CliOptions): Promise<number> {
  const now = new Date();
  const runContext: RunContext = {
    options,
    now,
    window: { since: new Date(now.getTime() - options.days * DAY_MS), until: now },
    cloudflare: cloudflareFromEnv(options, now),
  };

  const rows = await loadWorkspaces(options.workspace);
  if (rows.length === 0) {
    progress(options.workspace ? 'No active workspace matches --workspace.' : 'No active workspaces with a database.');
    return 1;
  }

  progress(`Auditing ${rows.length} workspace(s), ${options.days} days, read-only.`);
  const { workspaces, failed } = await auditAll(rows, runContext);
  const report: AuditReport = {
    generatedAt: now.toISOString(),
    env: options.env,
    days: options.days,
    since: runContext.window.since.toISOString(),
    until: runContext.window.until.toISOString(),
    cloudflareDays: runContext.cloudflare ? runContext.cloudflare.windowDays : null,
    redacted: false,
    workspaces,
    failed,
  };

  const written = await writeReport(options.redact ? redactReport(report) : report, options);
  for (const file of written) progress(`Written: ${file}`);
  progress(`\nREMINDER: ${PRIVACY_NOTICE}`);
  if (failed.length > 0) progress(`${failed.length} workspace(s) failed; see the report.`);
  return failed.length > 0 ? 1 : 0;
}

let exitCode: number;
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    exitCode = 0;
  } else {
    exitCode = await run(options);
  }
} catch (err) {
  if (err instanceof ArgsError) {
    progress(`${err.message}\n\n${USAGE}`);
    exitCode = 2;
  } else if (err instanceof ConfigError) {
    progress(err.message);
    exitCode = 1;
  } else {
    progress(`Fatal: ${sanitize(err instanceof Error ? (err.stack ?? err.message) : String(err))}`);
    exitCode = 1;
  }
}
process.exit(exitCode);
