/**
 * Shapes shared by the inbound-mail parsing helpers (`lib/inbound/*`) and the
 * services that act on a parsed message.
 */

import type { ReachInboundKind } from '@weldsuite/db/schema';

/** One decoded MIME part that matters for delivery reports (DSN, original message, headers only). */
export interface ReportPart {
  /** Lower-cased MIME type: `message/delivery-status`, `message/rfc822`, `text/rfc822-headers`, ... */
  mimeType: string;
  /** Decoded body of the part. */
  text: string;
}

export interface ParsedAddress {
  /** Lower-cased. */
  email: string;
  name: string | null;
}

/** A raw message normalised for reply handling. */
export interface ParsedInbound {
  /** RFC 5322 Message-ID without angle brackets, as the message states it (null when absent). */
  messageId: string | null;
  inReplyTo: string | null;
  /** Referenced Message-IDs without angle brackets, oldest first. */
  references: string[];
  from: ParsedAddress | null;
  /** Visible To: addresses, lower-cased. */
  to: string[];
  subject: string;
  /** Plain text of the message: the text part, or the HTML part converted to text. */
  text: string;
  /** Lower-cased header name to the first value. */
  headers: Record<string, string>;
  /** The top-level Content-Type header value (empty when absent). */
  contentType: string;
  /** Delivery-report related parts (`message/delivery-status`, an attached original, ...). */
  reportParts: ReportPart[];
}

/** What a delivery failure notice says. */
export interface BounceInfo {
  /** Failed recipients, lower-cased. */
  recipients: string[];
  /** Message-ID of the message that bounced, without angle brackets. */
  originalMessageId: string | null;
  /** Enhanced status code, e.g. `5.1.1`. */
  status: string | null;
  /** DSN `Action`: failed | delayed | delivered | relayed | expanded. */
  action: string | null;
  diagnostic: string | null;
  /** The failure is final: retrying will not help. */
  permanent: boolean;
  /** The recipient address itself is bad (unknown user, mailbox gone). False for policy and reputation blocks. */
  addressRejected: boolean;
  source: 'dsn' | 'text';
}

export interface InboundClassification {
  kind: ReachInboundKind;
  bounce: BounceInfo | null;
  /** Why it was judged an auto-reply (header or subject), for logs. */
  autoReplyReason: string | null;
}
