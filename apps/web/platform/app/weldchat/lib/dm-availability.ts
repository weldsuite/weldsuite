/**
 * Who can be messaged. Someone invited to the workspace can't be until they
 * accept: chat-api refuses the DM with a 409 (see the invitee section of
 * `@weldsuite/app-api-client/schemas/chat-dm`), and these helpers let the UI
 * hide or disable the way in first.
 */

import { isApiError } from '@weldsuite/api-client';
import {
  DM_INVITATION_PENDING,
  isPendingInvitee,
} from '@weldsuite/app-api-client/schemas/chat-dm';

export { isPendingInvitee };

type MemberLike = { status?: string | null; userId?: string | null };

/** True when the member exists and has joined, so a DM with them can be opened. */
export function canMessageMember(member: MemberLike | null | undefined): boolean {
  return !!member && !isPendingInvitee(member);
}

/** The members who have joined, for a picker that sends straight to a DM. */
export function withoutInvitees<T extends MemberLike>(members: readonly T[]): T[] {
  return members.filter((m) => !isPendingInvitee(m));
}

/** Everyone, with invitees moved to the end (order otherwise kept), for a picker that shows them disabled. */
export function inviteesLast<T extends MemberLike>(members: readonly T[]): T[] {
  return [...withoutInvitees(members), ...members.filter((m) => isPendingInvitee(m))];
}

/** chat-api's answer to a DM with someone who has not accepted their invitation. */
export function isInvitationPendingError(err: unknown): boolean {
  if (!isApiError(err) || err.status !== 409) return false;
  const body = err.body as { error?: { details?: { reason?: unknown } } } | undefined;
  return body?.error?.details?.reason === DM_INVITATION_PENDING;
}
