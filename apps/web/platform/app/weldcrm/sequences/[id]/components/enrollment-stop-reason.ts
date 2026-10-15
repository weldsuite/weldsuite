/**
 * Why an enrollment is not getting emails right now, when the cause is the
 * workspace's sending limit (outbound mail guard, docs/plans/weldmail-outbound-abuse.md).
 *
 * The sequence's `send_email` step paces itself against the limit; a workspace
 * on `hold` pauses its enrollments with reason `sending_limited`. The reason
 * reaches the client in `stopReason`, or, while the API has no such column yet,
 * in the enrollment's `errorMessage` (a step that failed with the guard's
 * `SENDING_LIMITED` code carries it there). Pure and i18n-free: the People tab
 * maps the result to its own strings.
 */

export const SENDING_LIMITED_REASON = 'sending_limited';

/** What the limit did to the enrollment: paused it, makes it wait, or stopped it. */
export type SendingLimitedVariant = 'paused' | 'waiting' | 'stopped';

interface EnrollmentReasonFields {
  status: string;
  stopReason?: string | null;
  errorMessage?: string | null;
}

const VARIANT_BY_STATUS: Readonly<Record<string, SendingLimitedVariant>> = {
  paused: 'paused',
  active: 'waiting',
  pending: 'waiting',
  failed: 'stopped',
};

function mentionsSendingLimit(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(SENDING_LIMITED_REASON);
}

/**
 * How the sending limit affects this enrollment, or `null` when it does not.
 * Completed and unenrolled people are done, whatever an old reason says.
 */
export function getSendingLimitedVariant(enrollment: EnrollmentReasonFields): SendingLimitedVariant | null {
  const variant = VARIANT_BY_STATUS[enrollment.status];
  if (!variant) return null;
  return mentionsSendingLimit(enrollment.stopReason) || mentionsSendingLimit(enrollment.errorMessage) ? variant : null;
}
