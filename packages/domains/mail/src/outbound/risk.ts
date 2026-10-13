/**
 * Workspace risk score (0–100) from the ledger's aggregates. Pure.
 *
 * The weights are a starting point to be tuned on shadow-mode data; the
 * thresholds that act on the score live in OUTBOUND_THRESHOLDS.
 */

import { OUTBOUND_THRESHOLDS, type OutboundTrustLevel } from '@weldsuite/app-api-client/schemas/outbound-mail';

export interface RiskInput {
  trustLevel: OutboundTrustLevel;
  /** Last 24 hours. */
  recipientsDay: number;
  firstContactDay: number;
  /** Recipients reached through API, CRM sequences and WeldConnect. */
  automatedDay: number;
  /** Sends whose content screen scored 3 or more, and all sends. */
  flaggedSendsDay: number;
  sendsDay: number;
  /** Most first-contact recipients any one template reached today. */
  topTemplateFirstContact: number;
  /** Last 7 days, from Cloudflare events. */
  recipients7d: number;
  hardBounces7d: number;
  complaints7d: number;
  /** Templates the AI called cold outreach / bulk today. */
  coldTemplates: number;
  phishingVerdict: boolean;
}

export interface RiskResult {
  score: number;
  reasons: string[];
  hardBounceRate7d: number | null;
  complaintRate7d: number | null;
}

export function computeRisk(input: RiskInput): RiskResult {
  const reasons: string[] = [];
  let score = 0;

  if (input.phishingVerdict) {
    return {
      score: 100,
      reasons: ['phishing_verdict'],
      ...rates(input),
    };
  }

  if (input.recipientsDay >= 20) {
    const share = input.firstContactDay / input.recipientsDay;
    const points = Math.round(share * 30);
    if (points > 0) {
      score += points;
      reasons.push(`first_contact_share:${share.toFixed(2)}`);
    }
  }

  if (input.topTemplateFirstContact >= 50) score += 30;
  else if (input.topTemplateFirstContact >= OUTBOUND_THRESHOLDS.coldTemplateFirstContactPerDay) score += 20;
  else if (input.topTemplateFirstContact >= OUTBOUND_THRESHOLDS.reviewFirstContactRecipients) score += 10;
  if (input.topTemplateFirstContact >= OUTBOUND_THRESHOLDS.reviewFirstContactRecipients) {
    reasons.push(`template_first_contact:${input.topTemplateFirstContact}`);
  }

  const { hardBounceRate7d, complaintRate7d } = rates(input);
  if (hardBounceRate7d !== null) {
    if (hardBounceRate7d > 0.1) score += 35;
    else if (hardBounceRate7d > OUTBOUND_THRESHOLDS.hardBounceRate) score += 25;
    else if (hardBounceRate7d > 0.02) score += 10;
    if (hardBounceRate7d > 0.02) reasons.push(`hard_bounce_rate:${hardBounceRate7d.toFixed(3)}`);
  }

  if (input.complaints7d >= OUTBOUND_THRESHOLDS.complaints7d) score += 30;
  else if (input.complaints7d === 1) score += 10;
  if (input.complaints7d > 0) reasons.push(`complaints:${input.complaints7d}`);

  if (input.sendsDay >= 10 && input.flaggedSendsDay / input.sendsDay > 0.3) {
    score += 10;
    reasons.push('flagged_content');
  }

  if (
    input.recipientsDay >= 20 &&
    input.automatedDay / input.recipientsDay > 0.5 &&
    input.firstContactDay / input.recipientsDay > 0.5
  ) {
    score += 10;
    reasons.push('automated_first_contact');
  }

  if (input.coldTemplates > 0) {
    score += 15;
    reasons.push(`cold_templates:${input.coldTemplates}`);
  }

  if (input.trustLevel === 'new') score *= 1.2;
  else if (input.trustLevel === 'trusted') score *= 0.8;

  return { score: Math.min(100, Math.round(score)), reasons, hardBounceRate7d, complaintRate7d };
}

function rates(input: RiskInput): Pick<RiskResult, 'hardBounceRate7d' | 'complaintRate7d'> {
  if (input.recipients7d < OUTBOUND_THRESHOLDS.hardBounceMinRecipients) {
    return { hardBounceRate7d: null, complaintRate7d: null };
  }
  return {
    hardBounceRate7d: input.hardBounces7d / input.recipients7d,
    complaintRate7d: input.complaints7d / input.recipients7d,
  };
}
