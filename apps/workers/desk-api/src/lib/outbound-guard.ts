/**
 * Glue between WeldDesk's email replies and the outbound mail guard
 * (`@weldsuite/mail-domain/outbound`, docs/plans/weldmail-outbound-abuse.md).
 *
 * An agent answering a customer who wrote in is `kind: 'reply'`, so the guard
 * never throttles it below its generous floor. It still refuses a From address
 * that belongs to another workspace, a recipient who reported this workspace's
 * mail as spam, and a suspended workspace.
 */

import { OutboundDeniedError } from '@weldsuite/mail-domain/outbound';
import { logSafe } from '@weldsuite/worker-kit/log-safe';

/** Who a reply is sent for, and where the guard's bookkeeping may run after the response. */
export interface DeskOutboundContext {
  /** Clerk org id of the workspace (`c.get('clerkOrgId')` in the kit). */
  clerkOrgId: string;
  /** Lets the guard count the send after the response; omitted when already inside a `waitUntil`. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** A refused reply is a policy decision, not a failure: log it as a warning with its code. */
export function warnReplyBlocked(scope: string, conversationId: string, err: OutboundDeniedError): void {
  console.warn(
    `[${scope}] Reply for conversation ${logSafe(conversationId)} blocked by the outbound guard (${err.code}): ${err.message}`,
  );
}
