/**
 * What can be done to a recipient of a sent request. The server decides who may
 * act at all (`canRemind`); these rules pick the recipients each action fits.
 */

import type { SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

type TurnState = Pick<SignRecipientDto, 'role' | 'status'>;

/** A signer whose turn it is: they have their link and have not signed or declined. */
export function isSigningNow(recipient: TurnState): boolean {
  return recipient.role === 'signer' && (recipient.status === 'sent' || recipient.status === 'opened');
}

/** Anyone who has not signed or declined yet, including signers still waiting and copy recipients. */
export function canCorrectEmail(recipient: Pick<SignRecipientDto, 'status'>): boolean {
  return recipient.status !== 'signed' && recipient.status !== 'declined';
}
