/**
 * How the audited traffic compares with the plan's proposed limits
 * (OUTBOUND_DEFAULT_LIMITS), so thresholds are set against real numbers. Pure.
 *
 * Approximations, stated in the report: windows are UTC calendar days and clock
 * hours, not the guard's rolling 24 hours; CRM sequence and WeldConnect sends
 * count towards the workspace's daily total but have no mailbox breakdown.
 */

import {
  OUTBOUND_DEFAULT_LIMITS,
  WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY,
  computeTrustLevel,
  type OutboundTrustLevel,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import { isSharedDomainAddress } from './recipients';
import { RECIPIENT_BUCKETS, type AutomationDay, type LimitOverruns, type MailSummary } from './types';

export interface TrustFacts {
  createdAt: Date;
  subscriptionStatus: string | null;
  planPriceMonthly: number | null;
  compGranted: boolean;
}

/**
 * The trust level the guard would compute today. There is no bounce data yet,
 * so it never reaches `trusted` (that needs a clean 7-day record).
 */
export function estimateTrustLevel(facts: TrustFacts, now: Date): OutboundTrustLevel {
  return computeTrustLevel({
    createdAt: facts.createdAt,
    subscriptionStatus: facts.subscriptionStatus,
    planPriceMonthly: facts.planPriceMonthly,
    compGranted: facts.compGranted,
    trustOverride: null,
    hardBounceRate7d: null,
    complaintRate7d: null,
    now,
  });
}

/** Messages with more recipients than `cap`, from the per-message histogram. */
export function messagesOver(recipientsPerMessage: Record<string, number>, cap: number): number {
  let total = 0;
  for (const bucket of RECIPIENT_BUCKETS) {
    if (bucket.min > cap) total += recipientsPerMessage[bucket.label] ?? 0;
  }
  return total;
}

export function evaluateProposedLimits(
  mail: MailSummary | null,
  automationDays: AutomationDay[],
  trustLevel: OutboundTrustLevel,
): LimitOverruns {
  const limits = OUTBOUND_DEFAULT_LIMITS[trustLevel];

  const workspacePerDay = new Map<string, number>();
  for (const day of mail?.days ?? []) workspacePerDay.set(day.day, (workspacePerDay.get(day.day) ?? 0) + day.recipients);
  for (const day of automationDays) workspacePerDay.set(day.day, (workspacePerDay.get(day.day) ?? 0) + day.sent);

  const byValue = <T extends { value: number }>(a: T, b: T) => b.value - a.value;

  const workspaceDays = [...workspacePerDay.entries()]
    .filter(([, value]) => value > limits.workspacePerDay)
    .map(([day, value]) => ({ day, value }))
    .sort(byValue);

  const firstContactDays = (mail?.days ?? [])
    .filter((d) => d.firstContactRecipients > limits.firstContactPerDay)
    .map((d) => ({ day: d.day, value: d.firstContactRecipients }))
    .sort(byValue);

  const mailboxDays = (mail?.mailboxDays ?? [])
    .filter((d) => d.recipients > limits.senderPerDay)
    .map((d) => ({ day: d.day, mailbox: d.mailbox, value: d.recipients }))
    .sort(byValue);

  const mailboxHours = (mail?.mailboxDays ?? [])
    .filter((d) => d.peakHourRecipients > limits.senderPerHour)
    .map((d) => ({ day: d.day, mailbox: d.mailbox, value: d.peakHourRecipients }))
    .sort(byValue);

  const sharedDomainFirstContactDays = (mail?.mailboxDays ?? [])
    .filter((d) => isSharedDomainAddress(d.mailbox) && d.firstContactRecipients > WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY)
    .map((d) => ({ day: d.day, mailbox: d.mailbox, value: d.firstContactRecipients }))
    .sort(byValue);

  return {
    trustLevel,
    limits: {
      recipientsPerMessage: limits.recipientsPerMessage,
      senderPerHour: limits.senderPerHour,
      senderPerDay: limits.senderPerDay,
      workspacePerDay: limits.workspacePerDay,
      firstContactPerDay: limits.firstContactPerDay,
      sharedDomainFirstContactPerDay: WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY,
    },
    workspaceDays,
    firstContactDays,
    mailboxDays,
    mailboxHours,
    messagesOverRecipientCap: mail ? messagesOver(mail.recipientsPerMessage, limits.recipientsPerMessage) : 0,
    sharedDomainFirstContactDays,
  };
}

/** True when any proposed limit would have been hit in the window. */
export function hasOverruns(overruns: LimitOverruns): boolean {
  return (
    overruns.workspaceDays.length > 0 ||
    overruns.firstContactDays.length > 0 ||
    overruns.mailboxDays.length > 0 ||
    overruns.mailboxHours.length > 0 ||
    overruns.messagesOverRecipientCap > 0 ||
    overruns.sharedDomainFirstContactDays.length > 0
  );
}
