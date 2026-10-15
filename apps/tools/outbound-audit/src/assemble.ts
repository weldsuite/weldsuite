/** Combines one workspace's partial summaries into its audit entry, and ranks them. Pure. */

import type { OutboundTrustLevel } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { evaluateProposedLimits } from './limits';
import { suspicionScore } from './score';
import type {
  AutomationDay,
  CloudflareSummary,
  MailSummary,
  SequenceSummary,
  WorkflowSummary,
  WorkspaceAudit,
} from './types';

export interface AssembleInput {
  workspace: { id: string; name: string; slug: string; createdAt: Date; subscriptionStatus: string | null };
  trustLevel: OutboundTrustLevel;
  mail: MailSummary | null;
  sequences: SequenceSummary | null;
  workflows: WorkflowSummary | null;
  cloudflare: CloudflareSummary | null;
  notes: string[];
}

export function mergeAutomationDays(...lists: AutomationDay[][]): AutomationDay[] {
  const days = new Map<string, AutomationDay>();
  for (const list of lists) {
    for (const entry of list) {
      const existing = days.get(entry.day);
      if (existing) {
        existing.sent += entry.sent;
        existing.failed += entry.failed;
      } else {
        days.set(entry.day, { ...entry });
      }
    }
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function hasActivity(audit: WorkspaceAudit): boolean {
  return (
    audit.volume > 0 ||
    (audit.mail?.totals.messages ?? 0) > 0 ||
    (audit.sequences?.failed ?? 0) > 0 ||
    (audit.workflows?.failedSteps ?? 0) > 0 ||
    (audit.cloudflare?.emails ?? 0) > 0
  );
}

export function assembleWorkspace(input: AssembleInput): WorkspaceAudit {
  const { mail, sequences, workflows, cloudflare } = input;
  const volume = (mail?.totals.recipients ?? 0) + (sequences?.sent ?? 0) + (workflows?.sent ?? 0);
  const known = (mail?.totals.recipients ?? 0) + (sequences?.recipientsKnown ?? 0);
  const firstContact = (mail?.totals.firstContactRecipients ?? 0) + (sequences?.firstContactRecipients ?? 0);
  const firstContactShare = known > 0 ? firstContact / known : null;
  const flaggedShare = mail && mail.content.screened > 0 ? mail.content.flagged / mail.content.screened : null;

  const score = suspicionScore({
    volume,
    firstContactShare,
    topTemplateReach: mail?.templates[0]?.distinctFirstContact ?? 0,
    flaggedShare,
    bounceShare: cloudflare?.bounceShare ?? null,
  });

  const automationDays = mergeAutomationDays(sequences?.days ?? [], workflows?.days ?? []);

  return {
    id: input.workspace.id,
    name: input.workspace.name,
    slug: input.workspace.slug,
    createdAt: input.workspace.createdAt.toISOString(),
    subscriptionStatus: input.workspace.subscriptionStatus,
    trustLevel: input.trustLevel,
    volume,
    firstContactShare,
    mail,
    sequences,
    workflows,
    cloudflare,
    limits: evaluateProposedLimits(mail, automationDays, input.trustLevel),
    score,
    notes: input.notes,
  };
}

export function rankWorkspaces(audits: WorkspaceAudit[]): WorkspaceAudit[] {
  return [...audits].sort(
    (a, b) => b.score.score - a.score.score || b.volume - a.volume || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}
