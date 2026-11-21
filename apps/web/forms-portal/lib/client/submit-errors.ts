/**
 * What the respondent reads when a submit fails. The renderer's own text
 * (`renderer.submitFailed`) is about the connection, so it only fits a request
 * that never got an answer; when forms-api did answer, its reason is shown.
 */

import type { PortalStrings } from '@/lib/i18n'
import { ApiError } from '@/lib/client/api'

type StateKey = keyof PortalStrings['states']

/** The closed-state text for a FORM_CLOSED / FORM_UNAVAILABLE answer (its `details.state`). */
function closedText(details: Record<string, unknown> | undefined, t: PortalStrings): string {
  const state = details?.state
  const known = typeof state === 'string' && Object.prototype.hasOwnProperty.call(t.states, state)
  const text = t.states[known ? (state as StateKey) : 'closed']
  return `${text.title}. ${text.body}`
}

/** The message for a failed submit; null when the request got no answer (offline), so the connection text fits. */
export function submitRefusal(err: unknown, t: PortalStrings): string | null {
  if (!(err instanceof ApiError) || err.status === 0) return null
  switch (err.code) {
    case 'SUBMISSION_REJECTED':
      return t.submit.rejected
    case 'RATE_LIMITED':
      return t.submit.rateLimited
    case 'ALREADY_SUBMITTED':
      return t.submit.alreadySubmitted
    case 'BOT_CHECK_FAILED':
      return t.verify.botFailed
    case 'FORM_CLOSED':
    case 'FORM_UNAVAILABLE':
      return closedText(err.details, t)
    default:
      return t.submit.failed
  }
}
