/**
 * Delivery failure notices: RFC 3464 delivery status notifications (Gmail,
 * Exchange / Outlook, Postfix and most MTAs), and the plain-text
 * "Mail Delivery Subsystem" style notices some systems send without a
 * machine-readable report.
 *
 * What the rest of the pipeline needs from a bounce: which message bounced
 * (its Message-ID, to find the enrollment), which recipients failed, and
 * whether the failure is final and the address itself is bad.
 */

import { extractAddress } from './token';
import { normalizeMessageId } from './message-id';
import { emailAfter, findEmails, stripParenthesized } from '@weldsuite/reach-domain/inbound/strings';
import { isQuoteSeparator } from '@weldsuite/reach-domain/inbound/text';
import type { BounceInfo, ParsedInbound } from './types';

const SYSTEM_LOCAL_PARTS = new Set([
  'mailer-daemon',
  'mailerdaemon',
  'postmaster',
  'mail-delivery-subsystem',
  'mail.delivery.subsystem',
  'mail-delivery-system',
  'delivery',
  'bounce',
  'bounces',
  'no-reply-bounce',
]);

const SYSTEM_DISPLAY_NAMES = ['mail delivery subsystem', 'mail delivery system', 'mailer-daemon', 'mailer daemon', 'postmaster', 'mail delivery failed', 'undeliverable'];

/** Subjects (lower-cased) that start a delivery failure notice, in English, Dutch, German and French. */
const BOUNCE_SUBJECT_PREFIXES = [
  'undeliverable',
  'undelivered mail',
  'delivery status notification',
  'returned mail',
  'mail delivery failed',
  'mail delivery failure',
  'delivery failure',
  'delivery failed',
  'delivery has failed',
  'failure notice',
  'non-delivery',
  'non delivery',
  'message not delivered',
  'message undeliverable',
  'bericht niet bezorgd',
  'niet bezorgd',
  'onbestelbaar',
  'kon niet worden bezorgd',
  'unzustellbar',
  'zustellung fehlgeschlagen',
  'nicht zustellbar',
  'échec de la distribution',
  'échec de distribution',
  'echec de distribution',
];

const DELAY_HINTS = ['delay', 'will keep trying', 'will continue to try', 'still trying', 'temporar', 'deferred', 'retry for', 'vertraagd', 'verzögert'];

/** The address is the problem. */
const ADDRESS_HINTS = [
  "couldn't be found",
  'could not be found',
  'does not exist',
  "doesn't exist",
  'user unknown',
  'unknown user',
  'no such user',
  'no such recipient',
  'no such mailbox',
  'recipient not found',
  'recipient address rejected',
  'recipient rejected',
  'address not found',
  'address rejected',
  'mailbox unavailable',
  'mailbox not found',
  'mailbox disabled',
  'invalid recipient',
  'invalid address',
  'unrouteable',
  'bestaat niet',
  'niet gevonden',
  'existiert nicht',
  'unbekannt',
];

/** The sender's reputation or the receiver's policy is the problem. */
const POLICY_HINTS = [
  'spam',
  'blocked',
  'block list',
  'blocklist',
  'blacklist',
  'reputation',
  'spamhaus',
  'policy',
  'denied',
  'not authorized',
  'not authorised',
  'unauthenticated',
  'dmarc',
  'spf',
  'rate limit',
  'too many',
];

/** Phrases that introduce the failed recipient in a plain-text notice (lower-cased, straight apostrophes). */
const FAILED_TO_MARKERS = [
  "wasn't delivered to",
  'was not delivered to',
  "couldn't be delivered to",
  'could not be delivered to',
  'delivery has failed to these recipients',
  'delivery to the following recipient',
];

function mentionsAny(text: string, phrases: readonly string[]): boolean {
  const lower = text.toLowerCase().replaceAll('’', "'");
  return phrases.some((phrase) => lower.includes(phrase));
}

function isFieldName(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(key);
}

/** Parse `Key: value` lines of one DSN field group; continuation lines (leading whitespace) join the previous value. */
function parseFieldGroup(group: string): Map<string, string> {
  const fields = new Map<string, string>();
  let lastKey: string | null = null;
  for (const line of group.split(/\r?\n/)) {
    const continuation = (line.startsWith(' ') || line.startsWith('\t')) && line.trim() !== '';
    if (continuation && lastKey) {
      fields.set(lastKey, `${fields.get(lastKey) ?? ''} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0 || !isFieldName(line.slice(0, colon))) continue;
    lastKey = line.slice(0, colon).toLowerCase();
    if (!fields.has(lastKey)) fields.set(lastKey, line.slice(colon + 1).trim());
  }
  return fields;
}

/** `rfc822; user@host (comment)` or `user@host` to `user@host`. */
function parseRecipientField(value: string | undefined): string | null {
  if (!value) return null;
  const afterType = value.includes(';') ? value.slice(value.indexOf(';') + 1) : value;
  const address = extractAddress(stripParenthesized(afterType));
  return address.includes('@') ? address.replace(/^mailto:/, '') : null;
}

/** The headers of an embedded original: the part before the first blank line, with folded lines joined. */
function headerBlock(block: string): string {
  const [headers = ''] = block.split(/\r?\n\r?\n/, 1);
  return headers.replace(/\r?\n[ \t]+/g, ' ');
}

/** The first Message-ID header in a block of headers. */
function messageIdFromHeaders(block: string): string | null {
  const match = /^message-id:\s*(<[^>]+>|\S+)/im.exec(headerBlock(block));
  return match ? normalizeMessageId(match[1]) : null;
}

/** The addresses on a header line (`To:`) of an embedded original message. */
function headerAddresses(block: string, name: string): string[] {
  const match = new RegExp(`^${name}:(.+)$`, 'im').exec(headerBlock(block));
  return match ? findEmails(match[1]!).map((found) => found.email) : [];
}

function isPermanentStatus(status: string | null, action: string | null): boolean {
  const normalized = action?.toLowerCase();
  if (normalized === 'failed') return true;
  if (normalized === 'delayed') return false;
  return status?.startsWith('5') ?? false;
}

/** Whether the failure is about the address rather than the sender's reputation or policy. */
function isAddressFailure(permanent: boolean, status: string | null, evidence: string): boolean {
  if (!permanent) return false;
  if (status?.startsWith('5.7')) return false;
  return !(status === null && mentionsAny(evidence, POLICY_HINTS) && !mentionsAny(evidence, ADDRESS_HINTS));
}

interface DsnFields {
  perMessage: Map<string, string>;
  perRecipient: Map<string, string>[];
}

function parseDeliveryStatus(text: string): DsnFields {
  const groups = text.split(/\r?\n[ \t]*\r?\n/).filter((g) => g.trim() !== '');
  const [first, ...rest] = groups;
  const perMessage = first ? parseFieldGroup(first) : new Map<string, string>();
  const perRecipient = rest.map(parseFieldGroup).filter((g) => g.has('final-recipient') || g.has('original-recipient'));
  // Some MTAs omit the per-message group: the only group then is the recipient one.
  if (perRecipient.length === 0 && (perMessage.has('final-recipient') || perMessage.has('original-recipient'))) {
    return { perMessage: new Map(), perRecipient: [perMessage] };
  }
  return { perMessage, perRecipient };
}

interface RecipientVerdict {
  recipients: string[];
  status: string | null;
  action: string | null;
  diagnostic: string | null;
}

/** Fold the per-recipient groups into one verdict: the first failing recipient decides. */
function summarizeRecipients(groups: Map<string, string>[]): RecipientVerdict {
  const verdict: RecipientVerdict = { recipients: [], status: null, action: null, diagnostic: null };
  for (const group of groups) {
    const address = parseRecipientField(group.get('final-recipient')) ?? parseRecipientField(group.get('original-recipient'));
    if (address && !verdict.recipients.includes(address)) verdict.recipients.push(address);

    const groupStatus = group.get('status')?.split(/\s/)[0] ?? null;
    const groupAction = group.get('action')?.toLowerCase() ?? null;
    const decides = verdict.status === null || (groupAction === 'failed' && verdict.action !== 'failed');
    if (!decides) continue;
    verdict.status = groupStatus ?? verdict.status;
    verdict.action = groupAction ?? verdict.action;
    verdict.diagnostic = group.get('diagnostic-code') ?? verdict.diagnostic;
  }
  return verdict;
}

function bounceFromDsn(parsed: ParsedInbound): BounceInfo | null {
  const report = parsed.reportParts.find((p) => p.mimeType === 'message/delivery-status');
  const isReport = /multipart\/report/i.test(parsed.contentType) && /delivery-status/i.test(parsed.contentType);
  if (!report && !isReport) return null;

  const dsn: DsnFields = report ? parseDeliveryStatus(report.text) : { perMessage: new Map<string, string>(), perRecipient: [] };
  const original = parsed.reportParts.find((p) => p.mimeType === 'message/rfc822' || p.mimeType === 'text/rfc822-headers');
  const verdict = summarizeRecipients(dsn.perRecipient);
  if (verdict.recipients.length === 0 && original) verdict.recipients.push(...headerAddresses(original.text, 'to'));

  const originalMessageId =
    normalizeMessageId(dsn.perMessage.get('x-original-message-id')) ?? (original ? messageIdFromHeaders(original.text) : null);
  const permanent = isPermanentStatus(verdict.status, verdict.action);
  return {
    ...verdict,
    originalMessageId,
    permanent,
    addressRejected: isAddressFailure(permanent, verdict.status, `${verdict.diagnostic ?? ''} ${parsed.text}`),
    source: 'dsn',
  };
}

function looksLikeBounceSender(parsed: ParsedInbound): boolean {
  const from = parsed.from;
  if (from) {
    const local = from.email.split('@')[0] ?? '';
    if (SYSTEM_LOCAL_PARTS.has(local) || (local.startsWith('microsoftexchange') && local.length > 30)) return true;
    if (from.name && mentionsAny(from.name, SYSTEM_DISPLAY_NAMES)) return true;
  }
  const subject = parsed.subject.trim().toLowerCase();
  return BOUNCE_SUBJECT_PREFIXES.some((prefix) => subject.startsWith(prefix));
}

/** Failed recipients of a plain-text notice, best signal first. */
function recipientsFromText(text: string): string[] {
  const lower = text.toLowerCase().replaceAll('’', "'");
  const out: string[] = [];
  const add = (address: string | null | undefined): void => {
    if (address && !out.includes(address)) out.push(address);
  };

  for (const marker of FAILED_TO_MARKERS) {
    const at = lower.indexOf(marker);
    if (at >= 0) add(emailAfter(lower, at + marker.length));
  }
  // Postfix style: "<user@host>: host mx.example said: 550 ...".
  for (const found of findEmails(lower)) {
    if (/^>:\s{0,3}host\b/.test(lower.slice(found.end, found.end + 12))) add(found.email);
  }
  // The original message quoted below the notice names its recipient in To:.
  const lines = text.split(/\r?\n/);
  const separator = lines.findIndex((line) => isQuoteSeparator(line.trim()));
  if (separator >= 0) {
    for (const address of headerAddresses(lines.slice(separator + 1).join('\n').replace(/^\s+/, ''), 'to')) add(address);
  }
  return out;
}

function bounceFromText(parsed: ParsedInbound): BounceInfo | null {
  if (!looksLikeBounceSender(parsed)) return null;
  const text = parsed.text;

  const idMatch = /^message-id:\s*(<[^>\s]+>|\S+)/im.exec(text);
  // "550 5.1.1 ..." (SMTP reply with its enhanced code) beats a bare "5.1.1" somewhere in the text.
  const statusMatch =
    /\b[245]\d\d[ -]([245]\.\d{1,3}\.\d{1,3})\b/.exec(text) ?? /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(text);
  const status = statusMatch ? statusMatch[1]! : null;

  const delayed = mentionsAny(parsed.subject, DELAY_HINTS) || (status === null && mentionsAny(text, DELAY_HINTS));
  const permanent = status ? status.startsWith('5') : !delayed;
  return {
    recipients: recipientsFromText(text),
    originalMessageId: idMatch ? normalizeMessageId(idMatch[1]) : null,
    status,
    action: permanent ? 'failed' : 'delayed',
    diagnostic: null,
    permanent,
    addressRejected: isAddressFailure(permanent, status, text.slice(0, 4000)),
    source: 'text',
  };
}

/** The bounce a message reports, or null when it is not a delivery notice. */
export function parseBounce(parsed: ParsedInbound): BounceInfo | null {
  return bounceFromDsn(parsed) ?? bounceFromText(parsed);
}
