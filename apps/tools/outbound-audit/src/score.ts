/**
 * The audit's suspicion score: a ranking aid for staff, not the guard's risk
 * score. Pure.
 *
 *   score = 10 × V × F × T × C × B
 *
 *   V = log10(1 + recipients)          volume: WeldMail envelope recipients
 *                                      + CRM sequence + WeldConnect sends
 *   F = first-contact share (0..1)     of recipients whose status is known
 *                                      (WeldMail and sequence recipients);
 *                                      0.5 when only WeldConnect sent
 *   T = 1 + log10(1 + reach)           reach: distinct first-contact
 *                                      recipients of the top template
 *   C = 1 + flagged share              content screen score >= 3
 *   B = 1 + 10 × bounce share          only with --cloudflare data
 *
 * A workspace that only replies to people who wrote in scores 0, whatever its
 * volume. One template mailed to many strangers multiplies everything else.
 */

import type { ScoreResult } from './types';

export interface ScoreInput {
  volume: number;
  firstContactShare: number | null;
  topTemplateReach: number;
  flaggedShare: number | null;
  bounceShare: number | null;
}

const ASSUMED_FIRST_CONTACT_SHARE = 0.5;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function suspicionScore(input: ScoreInput): ScoreResult {
  const volume = Math.log10(1 + Math.max(0, input.volume));
  const firstContactAssumed = input.firstContactShare === null && input.volume > 0;
  const firstContact = input.firstContactShare ?? (firstContactAssumed ? ASSUMED_FIRST_CONTACT_SHARE : 0);
  const template = 1 + Math.log10(1 + Math.max(0, input.topTemplateReach));
  const content = 1 + (input.flaggedShare ?? 0);
  const bounce = input.bounceShare === null ? 1 : 1 + 10 * input.bounceShare;
  return {
    score: round(10 * volume * firstContact * template * content * bounce, 1),
    factors: {
      volume: round(volume, 2),
      firstContact: round(firstContact, 2),
      template: round(template, 2),
      content: round(content, 2),
      bounce: round(bounce, 2),
    },
    firstContactAssumed,
  };
}
