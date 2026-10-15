/**
 * `--redact`: the same numbers with workspace names, mailboxes and domains
 * replaced by stable labels and template text dropped, for sharing aggregate
 * figures (threshold tuning) beyond the staff who ran the audit. Pure.
 */

import type { AuditReport, CloudflareSummary, DomainCount, MailSummary, SequenceSummary, WorkspaceAudit } from './types';

class Labeler {
  private readonly labels = new Map<string, string>();
  constructor(private readonly prefix: string) {}
  label(value: string): string {
    let label = this.labels.get(value);
    if (!label) {
      label = `${this.prefix} #${this.labels.size + 1}`;
      this.labels.set(value, label);
    }
    return label;
  }
  /** Replaces every known value inside free text (problem messages). */
  scrub(text: string): string {
    let out = text;
    for (const [value, label] of [...this.labels.entries()].sort((a, b) => b[0].length - a[0].length)) {
      out = out.split(value).join(label);
    }
    return out;
  }
}

function redactDomains(list: DomainCount[], domains: Labeler): DomainCount[] {
  return list.map((d) => ({ domain: domains.label(d.domain), recipients: d.recipients }));
}

function redactMail(mail: MailSummary, mailboxes: Labeler, domains: Labeler): MailSummary {
  return {
    ...mail,
    mailboxes: mail.mailboxes.map((m) => ({ ...m, mailboxId: '', mailbox: mailboxes.label(m.mailbox) })),
    mailboxDays: mail.mailboxDays.map((d) => ({ ...d, mailboxId: '', mailbox: mailboxes.label(d.mailbox) })),
    topDomains: redactDomains(mail.topDomains, domains),
    templates: mail.templates.map((t) => ({
      ...t,
      mailboxes: t.mailboxes.map((m) => mailboxes.label(m)),
      subject: '[redacted]',
      snippet: '[redacted]',
    })),
  };
}

function redactSequences(sequences: SequenceSummary, domains: Labeler): SequenceSummary {
  return { ...sequences, topDomains: redactDomains(sequences.topDomains, domains) };
}

function redactCloudflare(cf: CloudflareSummary, senders: Labeler): CloudflareSummary {
  const domains = cf.domains.map((d) => ({ ...d, domain: senders.label(d.domain), zoneId: '' }));
  return { ...cf, domains, problems: cf.problems.map((p) => senders.scrub(p)) };
}

function redactWorkspace(audit: WorkspaceAudit, index: number): WorkspaceAudit {
  const mailboxes = new Labeler('mailbox');
  const recipientDomains = new Labeler('recipient domain');
  const senders = new Labeler('sending domain');
  const mail = audit.mail ? redactMail(audit.mail, mailboxes, recipientDomains) : null;
  return {
    ...audit,
    id: `workspace-${index + 1}`,
    name: `workspace #${index + 1}`,
    slug: '',
    mail,
    sequences: audit.sequences ? redactSequences(audit.sequences, recipientDomains) : null,
    cloudflare: audit.cloudflare ? redactCloudflare(audit.cloudflare, senders) : null,
    limits: audit.limits
      ? {
          ...audit.limits,
          mailboxDays: audit.limits.mailboxDays.map((d) => ({ ...d, mailbox: mailboxes.label(d.mailbox) })),
          mailboxHours: audit.limits.mailboxHours.map((d) => ({ ...d, mailbox: mailboxes.label(d.mailbox) })),
          sharedDomainFirstContactDays: audit.limits.sharedDomainFirstContactDays.map((d) => ({
            ...d,
            mailbox: mailboxes.label(d.mailbox),
          })),
        }
      : null,
    notes: audit.notes,
  };
}

export function redactReport(report: AuditReport): AuditReport {
  return {
    ...report,
    redacted: true,
    workspaces: report.workspaces.map((w, i) => redactWorkspace(w, i)),
    failed: report.failed.map((f, i) => ({ workspace: `failed workspace #${i + 1}`, error: f.error })),
  };
}
