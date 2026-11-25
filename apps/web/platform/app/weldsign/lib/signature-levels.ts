/**
 * Signature levels (eIDAS) on the sender's side: which levels the install
 * offers, what they cost and how many credits a request takes. Everything here
 * treats "no capabilities" (Global, or not loaded yet) as simple signatures only.
 */

import { isApiError } from '@weldsuite/api-client';
import type {
  SignCapabilities,
  SignEnvelopeDetail,
  SignRecipientDto,
  SignSignatureLevel,
  SignTrustLevel,
} from '@weldsuite/app-api-client/schemas/weldsign';

/** The level a recipient signs at; absent means simple. */
export const levelOf = (recipient: Pick<SignRecipientDto, 'signatureLevel'>): SignSignatureLevel => recipient.signatureLevel ?? 'ses';

/** Whether the install offers anything beyond simple signatures. */
export function offersTrustLevels(capabilities: SignCapabilities | null): capabilities is SignCapabilities {
  return capabilities !== null && capabilities.levels.some((level) => level !== 'ses');
}

/** The levels to offer in a picker: the offered ones, and the current one if it is no longer offered. */
export function pickableLevels(capabilities: SignCapabilities | null, current: SignSignatureLevel): SignSignatureLevel[] {
  const offered = capabilities?.levels ?? ['ses'];
  return (['ses', 'aes', 'qes'] as const).filter((level) => offered.includes(level) || level === current);
}

/** Credits per signer for a level; null for simple, or a level the install does not offer. */
export function levelPrice(capabilities: SignCapabilities | null, level: SignSignatureLevel): number | null {
  if (!capabilities || level === 'ses') return null;
  return capabilities.prices[level];
}

/** What a request will reserve when sent: its advanced and qualified signers, and their credits. */
export function creditsFor(
  envelope: Pick<SignEnvelopeDetail, 'recipientList'>,
  capabilities: SignCapabilities | null,
): { signers: number; credits: number } {
  let signers = 0;
  let credits = 0;
  for (const recipient of envelope.recipientList) {
    const level = levelOf(recipient);
    if (recipient.role !== 'signer' || level === 'ses') continue;
    signers += 1;
    credits += levelPrice(capabilities, level) ?? 0;
  }
  return { signers, credits };
}

export const isTrustLevel = (level: SignSignatureLevel): level is SignTrustLevel => level !== 'ses';

/** The shortfall a 402 from sending carries (`CreditShortfall`); every number may be missing. */
export interface CreditShortfallDetails {
  required: number | null;
  currentBalance: number | null;
  shortfall: number | null;
}

/** Reads a failed send: the shortfall when the workspace lacks the credits, null for any other error. */
export function creditShortfallOf(error: unknown): CreditShortfallDetails | null {
  if (!isApiError(error) || error.status !== 402) return null;
  const inner = (error.body as { error?: { code?: unknown; details?: Record<string, unknown> } } | undefined)?.error;
  // A 402 with another code is a plan limit, not a wallet shortfall.
  if (inner?.code !== undefined && inner.code !== 'INSUFFICIENT_CREDITS') return null;
  const number = (value: unknown) => (typeof value === 'number' ? value : null);
  return {
    required: number(inner?.details?.required),
    currentBalance: number(inner?.details?.currentBalance),
    shortfall: number(inner?.details?.shortfall),
  };
}
