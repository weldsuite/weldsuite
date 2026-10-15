/**
 * The send paths that store no SENT copy: CRM sequences and WeldConnect
 * `send_email` steps. Pure aggregation of what the readers return.
 *
 * - CRM sequences write a `workflow_executions` row per enrolment run
 *   (`trigger_data.source = 'sequence_enrollment'`) and one
 *   `workflow_execution_steps` row per step. The recipient is not stored; the
 *   enrolled contact's email (`sequence_enrollments.customer_snapshot`) is the
 *   best estimate, since sequence mails go to `{{contact.email}}`.
 * - WeldConnect writes a step row per `send_email` outside loops (output
 *   `{ success, messageId, from }`) and one row per loop-body step that sums up
 *   every iteration (output `{ runs, skipped }`, or a failed row whose error
 *   reads "X of N runs failed" when the loop carried on). Recipients are not
 *   stored at all, so only counts are possible.
 */

import { topCounts } from './mail-aggregate';
import { domainOf, isFirstContact, utcDay } from './recipients';
import type {
  AutomationDay,
  CorrespondentContext,
  EnrollmentRow,
  SequenceStepRow,
  SequenceSummary,
  WorkflowStepGroup,
  WorkflowSummary,
} from './types';

function dayEntry(days: Map<string, AutomationDay>, day: string): AutomationDay {
  let entry = days.get(day);
  if (!entry) {
    entry = { day, sent: 0, failed: 0 };
    days.set(day, entry);
  }
  return entry;
}

function sortedDays(days: Map<string, AutomationDay>): AutomationDay[] {
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function summarizeSequences(
  steps: SequenceStepRow[],
  enrollments: EnrollmentRow[],
  ctx: CorrespondentContext,
  topDomains: number,
): SequenceSummary {
  const days = new Map<string, AutomationDay>();
  const sequences = new Set<string>();
  const recipients = new Set<string>();
  const firstContact = new Set<string>();
  const domains = new Map<string, number>();
  let sent = 0;
  let failed = 0;
  let otherSteps = 0;
  let recipientsKnown = 0;
  let firstContactRecipients = 0;

  for (const step of steps) {
    const day = utcDay(step.at);
    if (step.status === 'completed') {
      sent++;
      dayEntry(days, day).sent++;
      sequences.add(step.sequenceId);
      if (step.recipient) {
        recipientsKnown++;
        recipients.add(step.recipient);
        const domain = domainOf(step.recipient);
        domains.set(domain, (domains.get(domain) ?? 0) + 1);
        if (isFirstContact(step.recipient, step.at, ctx)) {
          firstContactRecipients++;
          firstContact.add(step.recipient);
        }
      }
    } else if (step.status === 'failed') {
      failed++;
      dayEntry(days, day).failed++;
    } else {
      otherSteps++;
    }
  }

  const enrollmentDays = new Map<string, number>();
  const enrolledSequences = new Set<string>();
  let enrollmentTotal = 0;
  for (const row of enrollments) {
    enrollmentTotal += row.count;
    enrolledSequences.add(row.sequenceId);
    enrollmentDays.set(row.day, (enrollmentDays.get(row.day) ?? 0) + row.count);
  }

  return {
    sent,
    failed,
    otherSteps,
    sequences: sequences.size,
    recipientsKnown,
    distinctRecipients: recipients.size,
    firstContactRecipients,
    distinctFirstContact: firstContact.size,
    topDomains: topCounts(domains, topDomains),
    days: sortedDays(days),
    enrollments: {
      total: enrollmentTotal,
      sequences: enrolledSequences.size,
      days: [...enrollmentDays.entries()]
        .map(([day, count]) => ({ day, count }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    },
  };
}

const RUN_FAILURE = /^(\d+) of (\d+)$/;

/** Mails that went out from one grouped row. */
function sendsOf(group: WorkflowStepGroup): number {
  if (group.status === 'completed') return (group.runs ?? 1) * group.steps;
  if (group.status === 'failed' && group.runFailure) {
    const match = RUN_FAILURE.exec(group.runFailure);
    if (match) return Math.max(0, Number(match[2]) - Number(match[1])) * group.steps;
  }
  return 0;
}

export function summarizeWorkflowSends(groups: WorkflowStepGroup[]): WorkflowSummary {
  const days = new Map<string, AutomationDay>();
  const workflows = new Set<string>();
  let sent = 0;
  let failedSteps = 0;

  for (const group of groups) {
    const sends = sendsOf(group);
    const entry = dayEntry(days, group.day);
    if (sends > 0) {
      sent += sends;
      entry.sent += sends;
      workflows.add(group.workflowId);
    }
    if (group.status === 'failed') {
      failedSteps += group.steps;
      entry.failed += group.steps;
    }
  }

  return {
    sent,
    failedSteps,
    workflows: workflows.size,
    days: sortedDays(days).filter((d) => d.sent > 0 || d.failed > 0),
  };
}
