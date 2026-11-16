/**
 * Who can be messaged. Someone invited to the workspace can't be until they
 * accept: chat-api refuses the DM with a 409 (see the invitee section of
 * `@weldsuite/app-api-client/schemas/chat-dm`), and these helpers let the UI
 * hide or disable the way in first.
 */

import { isApiError } from '@weldsuite/api-client';
import { DM_INVITATION_PENDING } from '@weldsuite/app-api-client/schemas/chat-dm';

export { isPendingInvitee } from '@weldsuite/app-api-client/schemas/chat-dm';

/** chat-api's answer to a DM with someone who has not accepted their invitation. */
export function isInvitationPendingError(err: unknown): boolean {
  if (!isApiError(err) || err.status !== 409) return false;
  const body = err.body as { error?: { details?: { reason?: unknown } } } | undefined;
  return body?.error?.details?.reason === DM_INVITATION_PENDING;
}
