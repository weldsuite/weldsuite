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

/** One signal's contribution: points and, when it counts, the reason shown to staff. */
interface Signal {
  points: number;
  reason: string | null;
}

const NONE: Signal = { points: 0, reason: null };

function firstContactShare(input: RiskInput): Signal {
  if (input.recipientsDay < 20) return NONE;
  const share = input.firstContactDay / input.recipientsDay;
  const points = Math.round(share * 30);
  return points > 0 ? { points, reason: `first_contact_share:${share.toFixed(2)}` } : NONE;
}

function templateReach(input: RiskInput): Signal {
  const reach = input.topTemplateFirstContact;
  if (reach < OUTBOUND_THRESHOLDS.reviewFirstContactRecipients) return NONE;
  let points = 10;
  if (reach >= 50) points = 30;
  else if (reach >= OUTBOUND_THRESHOLDS.coldTemplateFirstContactPerDay) points = 20;
  return { points, reason: `template_first_contact:${reach}` };
}

function hardBounces(rate: number | null): Signal {
  if (rate === null || rate <= 0.02) return NONE;
  let points = 10;
  if (rate > 0.1) points = 35;
  else if (rate > OUTBOUND_THRESHOLDS.hardBounceRate) points = 25;
  return { points, reason: `hard_bounce_rate:${rate.toFixed(3)}` };
}

function complaints(input: RiskInput): Signal {
  if (input.complaints7d === 0) return NONE;
  const points = input.complaints7d >= OUTBOUND_THRESHOLDS.complaints7d ? 30 : 10;
  return { points, reason: `complaints:${input.complaints7d}` };
}

function flaggedContent(input: RiskInput): Signal {
  const flagged = input.sendsDay >= 10 && input.flaggedSendsDay / input.sendsDay > 0.3;
  return flagged ? { points: 10, reason: 'flagged_content' } : NONE;
}

function automatedFirstContact(input: RiskInput): Signal {
  const automated =
    input.recipientsDay >= 20 &&
    input.automatedDay / input.recipientsDay > 0.5 &&
    input.firstContactDay / input.recipientsDay > 0.5;
  return automated ? { points: 10, reason: 'automated_first_contact' } : NONE;
}

function coldTemplates(input: RiskInput): Signal {
  return input.coldTemplates > 0 ? { points: 15, reason: `cold_templates:${input.coldTemplates}` } : NONE;
}

const TRUST_WEIGHT: Record<OutboundTrustLevel, number> = { new: 1.2, standard: 1, trusted: 0.8 };

export function computeRisk(input: RiskInput): RiskResult {
  const deliveryRates = rates(input);
  if (input.phishingVerdict) return { score: 100, reasons: ['phishing_verdict'], ...deliveryRates };

  const signals = [
    firstContactShare(input),
    templateReach(input),
    hardBounces(deliveryRates.hardBounceRate7d),
    complaints(input),
    flaggedContent(input),
    automatedFirstContact(input),
    coldTemplates(input),
  ];
  const raw = signals.reduce((total, signal) => total + signal.points, 0) * TRUST_WEIGHT[input.trustLevel];
  return {
    score: Math.min(100, Math.round(raw)),
    reasons: signals.map((signal) => signal.reason).filter((reason): reason is string => reason !== null),
    ...deliveryRates,
  };
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
