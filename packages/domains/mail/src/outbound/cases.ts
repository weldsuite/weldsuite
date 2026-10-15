/**
 * Staff cases for the outbound guard: one row in master `outbound_mail_cases`
 * per trigger and subject per day (a dedupe key keeps repeats out).
 *
 * The alert email is not sent here: mail-api's 5-minute cron mails every case
 * with no `alertedAt` (apps/workers/mail-api/src/cron/outbound-alerts.ts). That
 * keeps @weldsuite/emails (and real React) out of this package, which every
 * mail-sending worker bundles.
 */

import { getMasterDb, masterSchema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { OutboundCaseSeverity, OutboundCaseTrigger } from '@weldsuite/app-api-client/schemas/outbound-mail';
import type { LedgerSubject, TemplateSummary } from './ledger-core';
import { recordOutboundEvent, type OutboundPolicyEnv } from './policy-store';

export type OutboundCaseEnv = OutboundPolicyEnv;

const { outboundMailCases } = masterSchema;

export interface OpenCaseInput {
  subject: LedgerSubject | { kind: 'platform' };
  trigger: OutboundCaseTrigger;
  severity: OutboundCaseSeverity;
  /** One sentence for staff. */
  summary: string;
  riskScore?: number | null;
  /** Sending state after any automatic action. */
  state?: string | null;
  template?: TemplateSummary;
  metrics?: Record<string, number | string | boolean | null>;
}

function dayStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function subjectId(subject: OpenCaseInput['subject']): string {
  if (subject.kind === 'platform') return 'platform';
  return subject.kind === 'workspace' ? subject.workspaceId : `personal:${subject.personalAccountId}`;
}

/**
 * Record a case unless an identical one (same subject, trigger, template, day)
 * exists. Returns the new case id, or null for a repeat or a failure. Never throws.
 */
export async function openOutboundCase(env: OutboundCaseEnv, input: OpenCaseInput): Promise<string | null> {
  try {
    const db = getMasterDb(env);
    const dedupeKey = [subjectId(input.subject), input.trigger, input.template?.fingerprint ?? '-', dayStamp()]
      .join(':')
      .slice(0, 200);
    const id = generateId('obcase');
    const verdict = input.template?.verdict;
    const inserted = await db
      .insert(outboundMailCases)
      .values({
        id,
        workspaceId: input.subject.kind === 'workspace' ? input.subject.workspaceId : null,
        personalAccountId: input.subject.kind === 'personal' ? input.subject.personalAccountId : null,
        trigger: input.trigger,
        severity: input.severity,
        fingerprint: input.template?.fingerprint ?? null,
        aiVerdict: verdict
          ? {
              category: verdict.category,
              unsolicited: verdict.unsolicited,
              confidence: verdict.confidence,
              signals: verdict.signals,
              modelId: verdict.modelId,
              reviewedAt: verdict.reviewedAt,
            }
          : null,
        riskScore: input.riskScore ?? null,
        snippet: input.template?.snippet.slice(0, 300) ?? null,
        subject: input.template?.subject.slice(0, 300) ?? null,
        sampleDomains: input.template?.domains ?? null,
        sources: input.template?.sources ?? null,
        metrics: {
          summary: input.summary,
          ...(input.state ? { state: input.state } : {}),
          ...(input.template ? { firstContactRecipients: input.template.firstContactRecipients } : {}),
          ...(input.metrics ?? {}),
        },
        dedupeKey,
      })
      .onConflictDoNothing({ target: outboundMailCases.dedupeKey })
      .returning({ id: outboundMailCases.id });
    if (inserted.length === 0) return null;

    if (input.subject.kind !== 'platform') {
      await recordOutboundEvent(db, input.subject, {
        kind: 'case_opened',
        toValue: input.trigger,
        reason: input.summary,
        actor: 'system',
        details: { caseId: id, severity: input.severity },
      });
    }
    return id;
  } catch (err) {
    console.error('[outbound] Failed to open case:', err instanceof Error ? err.message : err);
    return null;
  }
}
