import { describe, expect, it } from 'vitest';
import { assembleWorkspace, hasActivity, mergeAutomationDays, rankWorkspaces } from './assemble';
import { summarizeWorkflowSends } from './automation';
import { MailAccumulator } from './mail-aggregate';
import { redactReport } from './redact';
import { PRIVACY_NOTICE, cell, overrunKinds, renderJson, renderMarkdown } from './report';
import { MAILBOXES, allRecipientAddresses, coldCampaign, correspondents, everydayMail } from './__fixtures__/rows';
import type { AuditReport, MailSummary } from './types';

function mailOf(rows: ReturnType<typeof coldCampaign>): MailSummary {
  const acc = new MailAccumulator(correspondents(), MAILBOXES, { topTemplates: 20, topDomains: 20 });
  for (const row of rows) acc.add(row);
  return acc.finish();
}

function buildReport(): AuditReport {
  const workspace = (id: string, name: string) => ({
    id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    subscriptionStatus: 'active',
  });
  const cold = assembleWorkspace({
    workspace: workspace('org_cold', 'Cold Blasters | BV'),
    trustLevel: 'new',
    mail: mailOf([...coldCampaign(), ...everydayMail()]),
    sequences: null,
    workflows: summarizeWorkflowSends([
      { day: '2026-10-12', status: 'completed', workflowId: 'wf1', runs: 120, runFailure: null, steps: 1 },
    ]),
    cloudflare: null,
    notes: ['mail_correspondents not migrated yet: first contact computed from received mail in mail_messages.'],
  });
  const normal = assembleWorkspace({
    workspace: workspace('org_normal', 'Normal Shop'),
    trustLevel: 'standard',
    mail: mailOf(everydayMail()),
    sequences: null,
    workflows: null,
    cloudflare: null,
    notes: [],
  });
  const quiet = assembleWorkspace({
    workspace: workspace('org_quiet', 'Quiet Co'),
    trustLevel: 'standard',
    mail: mailOf([]),
    sequences: null,
    workflows: null,
    cloudflare: null,
    notes: [],
  });
  return {
    generatedAt: '2026-10-13T12:00:00.000Z',
    env: 'test',
    days: 30,
    since: '2026-09-13T12:00:00.000Z',
    until: '2026-10-13T12:00:00.000Z',
    cloudflareDays: null,
    redacted: false,
    workspaces: rankWorkspaces([normal, quiet, cold]),
    failed: [{ workspace: 'Broken (org_broken)', error: 'connect timeout' }],
  };
}

describe('assemble', () => {
  it('ranks the cold-mailing workspace first and the reply-only one at 0', () => {
    const report = buildReport();
    expect(report.workspaces.map((w) => w.id)).toEqual(['org_cold', 'org_normal', 'org_quiet']);
    const [cold, normal, quiet] = report.workspaces;
    expect(cold.volume).toBe(35 + 120);
    expect(cold.firstContactShare).toBeCloseTo(30 / 35);
    expect(cold.score.score).toBeGreaterThan(10);
    expect(normal.score.score).toBe(0);
    expect(hasActivity(quiet)).toBe(false);
    expect(overrunKinds(cold.limits)).toContain('weldmail.com first contact');
  });

  it('merges automation days', () => {
    expect(
      mergeAutomationDays(
        [{ day: '2026-10-11', sent: 1, failed: 0 }],
        [
          { day: '2026-10-10', sent: 2, failed: 1 },
          { day: '2026-10-11', sent: 3, failed: 2 },
        ],
      ),
    ).toEqual([
      { day: '2026-10-10', sent: 2, failed: 1 },
      { day: '2026-10-11', sent: 4, failed: 2 },
    ]);
  });
});

describe('renderMarkdown', () => {
  const report = buildReport();
  const markdown = renderMarkdown(report, { top: 5 });

  it('opens and closes with the customer-data notice', () => {
    expect(markdown.startsWith('# WeldMail outbound audit')).toBe(true);
    expect(markdown).toContain(`> **Customer data.** ${PRIVACY_NOTICE}`);
    expect(markdown.trimEnd().endsWith(`_${PRIVACY_NOTICE}_`)).toBe(true);
  });

  it('lists active workspaces in ranking order, counts the quiet ones and the failures', () => {
    expect(markdown.indexOf('## 1. Cold Blasters \\| BV')).toBeGreaterThan(0);
    expect(markdown.indexOf('## 2. Normal Shop')).toBeGreaterThan(markdown.indexOf('## 1. Cold Blasters'));
    expect(markdown).not.toContain('## 3.');
    expect(markdown).toContain('1 workspaces had no outbound activity in the window.');
    expect(markdown).toContain('- Broken (org_broken): connect timeout');
  });

  it('shows the template, the content screen, WeldConnect volume and the limits hit', () => {
    expect(markdown).toContain('Quick question for [name]');
    expect(markdown).toContain('2 templates tracked');
    expect(markdown).toContain('Flagged (score 3+): 30 of 34');
    expect(markdown).toContain('120 mails sent (loop iterations included) from 1 workflows');
    expect(markdown).toContain('### Proposed limits (trust level new');
    expect(markdown).toContain('> mail_correspondents not migrated yet');
  });

  it('never prints a recipient address', () => {
    const lower = markdown.toLowerCase();
    for (const email of allRecipientAddresses()) expect(lower).not.toContain(email);
  });
});

describe('renderJson and redaction', () => {
  it('puts the notice into the JSON', () => {
    const parsed = JSON.parse(renderJson(buildReport())) as { notice: string; workspaces: unknown[] };
    expect(parsed.notice).toBe(PRIVACY_NOTICE);
    expect(parsed.workspaces).toHaveLength(3);
  });

  it('replaces names, mailboxes and domains and drops template text', () => {
    const redacted = redactReport(buildReport());
    const json = renderJson(redacted);
    expect(redacted.redacted).toBe(true);
    for (const secret of ['Cold Blasters', 'org_cold', 'acme-ws.weldmail.com', 'support@acme.test', 'customer.org', 'Quick question', 'org_broken']) {
      expect(json).not.toContain(secret);
    }
    expect(redacted.workspaces[0].name).toBe('workspace #1');
    expect(redacted.workspaces[0].mail?.templates[0].snippet).toBe('[redacted]');
    expect(redacted.workspaces[0].mail?.mailboxes.map((m) => m.mailbox)).toEqual(['mailbox #1', 'mailbox #2']);
    // Numbers are untouched.
    expect(redacted.workspaces[0].score).toEqual(buildReport().workspaces[0].score);
  });
});

describe('cell', () => {
  it('escapes pipes, backticks and newlines for table cells', () => {
    expect(cell('a | b `c`\nd\\e')).toBe("a \\| b 'c' d\\\\e");
  });
});
