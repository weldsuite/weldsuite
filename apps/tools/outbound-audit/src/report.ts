/** Markdown and JSON rendering of the audit. Pure. */

import { hasActivity } from './assemble';
import { hasOverruns } from './limits';
import {
  RECIPIENT_BUCKETS,
  type AuditReport,
  type AutomationDay,
  type CloudflareSummary,
  type DomainCount,
  type LimitOverruns,
  type MailSummary,
  type SequenceSummary,
  type WorkflowSummary,
  type WorkspaceAudit,
} from './types';

export const PRIVACY_NOTICE =
  'This report holds customer data (workspace and mailbox names, recipient domains, template snippets). ' +
  'Do not commit it, paste it into tickets or chat, or share it outside staff. Delete it when you are done.';

const MAX_DAY_ROWS = 31;

export function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function num(value: number): string {
  return value.toLocaleString('en-US');
}

/** Text safe inside a markdown table cell. */
export function cell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, "'")
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function table(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

function domainList(domains: DomainCount[]): string {
  return domains.length === 0 ? 'none' : domains.map((d) => `${cell(d.domain)} (${num(d.recipients)})`).join(', ');
}

function workspaceLabel(audit: WorkspaceAudit): string {
  return audit.slug ? `${cell(audit.name)} (${cell(audit.slug)})` : cell(audit.name);
}

/** Names of the proposed limits the workspace would have hit. */
export function overrunKinds(limits: LimitOverruns | null): string[] {
  if (!limits) return [];
  const kinds: string[] = [];
  if (limits.workspaceDays.length > 0) kinds.push('workspace/day');
  if (limits.firstContactDays.length > 0) kinds.push('first contact/day');
  if (limits.mailboxDays.length > 0) kinds.push('sender/day');
  if (limits.mailboxHours.length > 0) kinds.push('sender/hour');
  if (limits.messagesOverRecipientCap > 0) kinds.push('recipients/message');
  if (limits.sharedDomainFirstContactDays.length > 0) kinds.push('weldmail.com first contact');
  return kinds;
}

function rankingRows(audits: WorkspaceAudit[]): string[][] {
  return audits.map((a, index) => {
    const mail = a.mail?.totals;
    return [
      String(index + 1),
      workspaceLabel(a),
      a.score.score.toFixed(1),
      num(a.volume),
      `${pct(a.firstContactShare)}${a.score.firstContactAssumed ? ' (assumed)' : ''}`,
      num(a.mail?.templates[0]?.distinctFirstContact ?? 0),
      mail ? `${num(mail.newThreads)} / ${num(mail.replies)}` : '-',
      a.sequences ? num(a.sequences.sent) : '-',
      a.workflows ? num(a.workflows.sent) : '-',
      a.mail && a.mail.content.screened > 0 ? pct(a.mail.content.flagged / a.mail.content.screened) : 'n/a',
      a.cloudflare ? pct(a.cloudflare.bounceShare) : '-',
      a.trustLevel,
      overrunKinds(a.limits).join(', ') || '-',
    ];
  });
}

/** `text` when `condition` holds, else nothing: optional fragments of a line. */
function when(condition: unknown, text: string): string {
  return condition ? text : '';
}

function mailSection(mail: MailSummary, top: number): string[] {
  const t = mail.totals;
  const lines: string[] = ['### WeldMail sends', ''];
  const withoutRecipients = when(t.messagesWithoutRecipients, ` (${num(t.messagesWithoutRecipients)} without recipients)`);
  const buckets = RECIPIENT_BUCKETS.map((b) => b.label + ': ' + num(mail.recipientsPerMessage[b.label] ?? 0)).join(', ');
  lines.push(
    `- Messages: ${num(t.messages)}${withoutRecipients}; new threads ${num(t.newThreads)}, replies ${num(t.replies)}, forwards ${num(t.forwards)}`,
    `- Recipients: ${num(t.recipients)} (to + cc + bcc), ${num(t.distinctRecipients)} distinct, ${num(t.distinctDomains)} domains; bcc ${num(t.bccRecipients)}`,
    `- First contact: ${num(t.firstContactRecipients)} recipients (${pct(t.firstContactShare)}), ${num(t.distinctFirstContact)} distinct; ${pct(t.firstContactReplyRate)} of those wrote back later`,
    `- Recipients per message: ${buckets}`,
    `- Active on ${num(t.activeDays)} days from ${num(t.activeMailboxes)} mailboxes`,
    '',
  );

  if (mail.mailboxes.length > 0) {
    lines.push('#### Mailboxes', '');
    lines.push(
      ...table(
        ['Mailbox', 'Provider', 'Messages', 'Recipients', 'Distinct', 'First contact', 'New / reply / fwd', 'Days', 'Peak day', 'Peak hour'],
        mail.mailboxes.map((m) => [
          `${cell(m.mailbox)}${m.deleted ? ' (deleted)' : ''}${m.sharedDomain ? ' (shared domain)' : ''}`,
          cell(m.sendProvider ?? '-'),
          num(m.messages),
          num(m.recipients),
          num(m.distinctRecipients),
          `${num(m.firstContactRecipients)} (${num(m.distinctFirstContact)} distinct)`,
          `${num(m.newThreads)} / ${num(m.replies)} / ${num(m.forwards)}`,
          num(m.activeDays),
          num(m.peakDayRecipients),
          num(m.peakHourRecipients),
        ]),
      ),
      '',
    );
  }

  const busiest = [...mail.mailboxDays].sort((a, b) => b.recipients - a.recipients || a.day.localeCompare(b.day)).slice(0, top);
  if (busiest.length > 0) {
    lines.push('#### Busiest mailbox-days (UTC)', '');
    lines.push(
      ...table(
        ['Day', 'Mailbox', 'Messages', 'Recipients', 'Distinct', 'Domains', 'First contact', 'New / reply', 'Peak hour'],
        busiest.map((d) => [
          d.day,
          cell(d.mailbox),
          num(d.messages),
          num(d.recipients),
          num(d.distinctRecipients),
          num(d.recipientDomains),
          `${num(d.firstContactRecipients)} (${num(d.distinctFirstContact)} distinct)`,
          `${num(d.newThreads)} / ${num(d.replies)}`,
          num(d.peakHourRecipients),
        ]),
      ),
      '',
    );
  }

  lines.push(`Top recipient domains: ${domainList(mail.topDomains.slice(0, top))}`, '');

  lines.push('#### Templates (new threads, by distinct first-contact recipients)', '');
  lines.push(
    `${num(t.templatesTracked)} templates tracked; ${num(t.templatesOverReviewThreshold)} reached 10+ first-contact recipients on one day (AI review threshold), ${num(t.templatesOverColdCap)} reached 25+ (cold-template cap).`,
    '',
  );
  if (mail.templates.length > 0) {
    lines.push(
      ...table(
        ['#', 'First contact', 'Peak day', 'Recipients', 'Messages', 'Days', 'Mailboxes', 'Flagged', 'Subject', 'Snippet'],
        mail.templates.slice(0, top).map((tpl, i) => [
          String(i + 1),
          num(tpl.distinctFirstContact),
          num(tpl.peakDayFirstContact),
          num(tpl.distinctRecipients),
          num(tpl.messages),
          num(tpl.days),
          num(tpl.mailboxes.length),
          num(tpl.flaggedMessages),
          cell(tpl.subject) || '-',
          cell(tpl.snippet) || '-',
        ]),
      ),
      '',
    );
  }

  const c = mail.content;
  const reasons = Object.entries(c.reasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([reason, count]) => `${reason} ${num(count)}`)
    .join(', ');
  lines.push(
    '#### Content screen',
    '',
    `Flagged (score 3+): ${num(c.flagged)} of ${num(c.screened)} (${pct(c.screened > 0 ? c.flagged / c.screened : null)}); cold outreach ${num(c.coldOutreach)}, bulk ${num(c.bulk)}, phishing ${num(c.phishing)}${when(reasons, '; reasons: ' + reasons)}`,
    '',
  );
  return lines;
}

function busiestDays(days: AutomationDay[], top: number): string {
  const busiest = [...days].sort((a, b) => b.sent - a.sent || a.day.localeCompare(b.day)).slice(0, top);
  return busiest.length === 0 ? 'none' : busiest.map((d) => `${d.day}: ${num(d.sent)} sent${when(d.failed, ', ' + num(d.failed) + ' failed')}`).join('; ');
}

function dailyTotals(audit: WorkspaceAudit): string[] {
  const days = new Map<string, { messages: number; recipients: number; firstContact: number; newThreads: number; sequences: number; workflows: number }>();
  const entry = (day: string) => {
    let row = days.get(day);
    if (!row) {
      row = { messages: 0, recipients: 0, firstContact: 0, newThreads: 0, sequences: 0, workflows: 0 };
      days.set(day, row);
    }
    return row;
  };
  for (const d of audit.mail?.days ?? []) {
    const row = entry(d.day);
    row.messages += d.messages;
    row.recipients += d.recipients;
    row.firstContact += d.firstContactRecipients;
    row.newThreads += d.newThreads;
  }
  for (const d of audit.sequences?.days ?? []) entry(d.day).sequences += d.sent;
  for (const d of audit.workflows?.days ?? []) entry(d.day).workflows += d.sent;
  if (days.size === 0) return [];

  const rows = [...days.entries()]
    .sort((a, b) => b[1].recipients + b[1].sequences + b[1].workflows - (a[1].recipients + a[1].sequences + a[1].workflows))
    .slice(0, MAX_DAY_ROWS)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return [
    `### Daily totals (UTC${when(days.size > MAX_DAY_ROWS, ', busiest ' + MAX_DAY_ROWS + ' days')})`,
    '',
    ...table(
      ['Day', 'Messages', 'Recipients', 'First contact', 'New threads', 'Sequence sends', 'WeldConnect sends'],
      rows.map(([day, r]) => [day, num(r.messages), num(r.recipients), num(r.firstContact), num(r.newThreads), num(r.sequences), num(r.workflows)]),
    ),
    '',
  ];
}

function limitCell<T extends { day: string; value: number }>(items: T[], unit: string): string {
  if (items.length === 0) return '-';
  const worst = items[0];
  return `${num(items.length)} ${unit} (max ${num(worst.value)} on ${worst.day})`;
}

function limitsSection(limits: LimitOverruns): string[] {
  const l = limits.limits;
  return [
    `### Proposed limits (trust level ${limits.trustLevel}, estimated; UTC days and clock hours)`,
    '',
    ...table(
      ['Limit', 'Proposed', 'Would have been hit'],
      [
        ['Workspace recipients per day (all paths)', num(l.workspacePerDay), limitCell(limits.workspaceDays, 'days')],
        ['First-contact recipients per day (WeldMail)', num(l.firstContactPerDay), limitCell(limits.firstContactDays, 'days')],
        ['Recipients per sender per day', num(l.senderPerDay), limitCell(limits.mailboxDays, 'mailbox-days')],
        ['Recipients per sender per hour', num(l.senderPerHour), limitCell(limits.mailboxHours, 'mailbox-days')],
        ['Recipients per message', num(l.recipientsPerMessage), limits.messagesOverRecipientCap ? `${num(limits.messagesOverRecipientCap)} messages` : '-'],
        ['First contact per weldmail.com sender per day', num(l.sharedDomainFirstContactPerDay), limitCell(limits.sharedDomainFirstContactDays, 'mailbox-days')],
      ],
    ),
    '',
  ];
}

function workspaceSection(audit: WorkspaceAudit, rank: number, top: number): string[] {
  const f = audit.score.factors;
  const lines: string[] = [
    `## ${rank}. ${workspaceLabel(audit)}`,
    '',
    `\`${cell(audit.id)}\` · created ${audit.createdAt.slice(0, 10)} · subscription ${cell(audit.subscriptionStatus ?? 'none')} · trust (est.) ${audit.trustLevel}`,
    '',
    `Score **${audit.score.score.toFixed(1)}** = 10 × V ${f.volume} × F ${f.firstContact}${audit.score.firstContactAssumed ? ' (assumed)' : ''} × T ${f.template} × C ${f.content} × B ${f.bounce}`,
    '',
  ];
  if (audit.notes.length > 0) {
    lines.push(...audit.notes.map((note) => `> ${cell(note)}`), '');
  }

  lines.push(...dailyTotals(audit));
  if (audit.mail && audit.mail.totals.messages > 0) lines.push(...mailSection(audit.mail, top));
  if (audit.sequences) lines.push(...sequencesSection(audit.sequences, top));
  if (audit.workflows) lines.push(...workflowsSection(audit.workflows, top));
  if (audit.cloudflare) lines.push(...cloudflareSection(audit.cloudflare));
  if (audit.limits && hasOverruns(audit.limits)) lines.push(...limitsSection(audit.limits));
  return lines;
}

function sequencesSection(s: SequenceSummary, top: number): string[] {
  if (s.sent === 0 && s.failed === 0 && s.enrollments.total === 0) return [];
  const share = pct(s.recipientsKnown > 0 ? s.firstContactRecipients / s.recipientsKnown : null);
  return [
    '### CRM sequences (no SENT copy)',
    '',
    `- send_email steps: ${num(s.sent)} sent, ${num(s.failed)} failed${when(s.otherSteps, ', ' + num(s.otherSteps) + ' other')}, from ${num(s.sequences)} sequences`,
    `- Recipients (enrolled contact): ${num(s.recipientsKnown)} known, ${num(s.distinctRecipients)} distinct; first contact ${num(s.firstContactRecipients)} (${share}), ${num(s.distinctFirstContact)} distinct`,
    `- Enrolments in the window: ${num(s.enrollments.total)} into ${num(s.enrollments.sequences)} sequences`,
    `- Top recipient domains: ${domainList(s.topDomains.slice(0, top))}`,
    `- Busiest days: ${busiestDays(s.days, top)}`,
    '',
  ];
}

function workflowsSection(w: WorkflowSummary, top: number): string[] {
  if (w.sent === 0 && w.failedSteps === 0) return [];
  return [
    '### WeldConnect send_email (no SENT copy, recipients not stored)',
    '',
    `- ${num(w.sent)} mails sent (loop iterations included) from ${num(w.workflows)} workflows; ${num(w.failedSteps)} failed steps`,
    `- Busiest days: ${busiestDays(w.days, top)}`,
    '',
  ];
}

function countsList(counts: Record<string, number>): string {
  return cell(
    Object.entries(counts)
      .map(([key, value]) => key + ' ' + num(value))
      .join(', '),
  );
}

function cloudflareSection(cf: CloudflareSummary): string[] {
  const lines = [`### Cloudflare Email Sending (last ${cf.days} days)`, ''];
  if (cf.domains.length > 0) {
    lines.push(
      ...table(
        ['Sending domain', 'Emails', 'Failed', 'Spam', 'Statuses', 'Event types'],
        cf.domains.map((d) => [cell(d.domain), num(d.emails), num(d.failed), num(d.spam), countsList(d.byStatus), countsList(d.byEventType)]),
      ),
      '',
      `Failed share ${pct(cf.bounceShare)}, spam share ${pct(cf.spamShare)} of ${num(cf.emails)} emails.`,
      '',
    );
  } else {
    lines.push("No Email Sending data for this workspace's domains.", '');
  }
  if (cf.problems.length > 0) lines.push(...cf.problems.map((p) => `- ${cell(p)}`), '');
  return lines;
}

export interface RenderOptions {
  top: number;
}

export function renderMarkdown(report: AuditReport, options: RenderOptions): string {
  const active = report.workspaces.filter(hasActivity);
  const quiet = report.workspaces.length - active.length;
  const lines: string[] = [
    '# WeldMail outbound audit',
    '',
    `> **Customer data.** ${PRIVACY_NOTICE}`,
    '',
    `- Environment: ${cell(report.env ?? 'not labelled')}`,
    `- Generated: ${report.generatedAt}`,
    `- Window: ${report.since} to ${report.until} (${report.days} days); Cloudflare: ${report.cloudflareDays === null ? 'not queried' : 'last ' + report.cloudflareDays + ' days'}`,
    `- Workspaces audited: ${num(report.workspaces.length)}, with outbound activity: ${num(active.length)}${when(report.failed.length, ', failed: ' + num(report.failed.length))}${when(report.redacted, ' (redacted)')}`,
    '- Score = 10 × V (log10 volume) × F (first-contact share) × T (1 + log10 top-template reach) × C (1 + flagged share) × B (1 + 10 × bounce share). A ranking aid, not a verdict; see the README.',
    '',
    '## Ranking',
    '',
  ];

  if (active.length > 0) {
    lines.push(
      ...table(
        ['#', 'Workspace', 'Score', 'Volume (all paths)', 'First contact', 'Top template reach', 'New / replies', 'Sequences', 'WeldConnect', 'Flagged', 'Bounce (CF)', 'Trust (est.)', 'Proposed limits hit'],
        rankingRows(active),
      ),
      '',
    );
  } else {
    lines.push('No outbound activity in the window.', '');
  }
  if (quiet > 0) lines.push(`${num(quiet)} workspaces had no outbound activity in the window.`, '');

  if (report.failed.length > 0) {
    lines.push('## Failed workspaces', '', ...report.failed.map((f) => `- ${cell(f.workspace)}: ${cell(f.error)}`), '');
  }

  active.forEach((audit, index) => lines.push(...workspaceSection(audit, index + 1, options.top)));
  lines.push('---', '', `_${PRIVACY_NOTICE}_`, '');
  return lines.join('\n');
}

export function renderJson(report: AuditReport): string {
  return `${JSON.stringify({ notice: PRIVACY_NOTICE, ...report }, null, 2)}\n`;
}
