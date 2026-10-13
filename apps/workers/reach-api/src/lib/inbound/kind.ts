/**
 * What kind of inbound message this is: a delivery failure, an automatic
 * reply, or a person answering. Checked in that order, because bounces also
 * carry `Auto-Submitted` and many auto-replies carry a person's `In-Reply-To`.
 */

import { detectAutoReply } from './auto-reply';
import { parseBounce } from './bounce';
import type { InboundClassification, ParsedInbound } from './types';

/** DSN actions that are good news, not failures: record them, do not stop the sequence. */
const SUCCESS_ACTIONS = new Set(['delivered', 'relayed', 'expanded']);

export function classifyInbound(parsed: ParsedInbound): InboundClassification {
  // Read receipts (`report-type=disposition-notification`) are system mail, never a reply.
  if (/multipart\/report/i.test(parsed.contentType) && /disposition-notification/i.test(parsed.contentType)) {
    return { kind: 'auto_reply', bounce: null, autoReplyReason: 'disposition-notification' };
  }

  const bounce = parseBounce(parsed);
  if (bounce) {
    if (bounce.action && SUCCESS_ACTIONS.has(bounce.action)) {
      return { kind: 'auto_reply', bounce: null, autoReplyReason: `dsn:${bounce.action}` };
    }
    return { kind: 'bounce', bounce, autoReplyReason: null };
  }

  const auto = detectAutoReply(parsed.headers, parsed.subject);
  if (auto.auto) return { kind: 'auto_reply', bounce: null, autoReplyReason: auto.reason };

  return { kind: 'reply', bounce: null, autoReplyReason: null };
}
