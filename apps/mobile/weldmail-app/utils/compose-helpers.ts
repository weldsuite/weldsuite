/**
 * Pure helpers extracted from the composer (`app/compose.tsx`) to cut the
 * duplicated recipient-parsing / quote-building logic out of the send handlers.
 * Extracted verbatim — behaviour matches the previous inline code exactly.
 */

import { isNetworkError } from '@weldsuite/api-client/client';

const ADDRESS_SEPARATOR = /[,;]\s*/;

/**
 * Send-or-queue policy for the composer. Attempts the live send; if it fails
 * purely because the device is offline (a {@link isNetworkError}), queues the
 * message instead and reports `'queued'`. Any other failure (server reject)
 * rethrows so the caller can surface a real error. Returning a discriminated
 * outcome keeps the offline decision unit-testable without rendering the screen.
 *
 * Both outcomes mean "the composer can close" — a queued message is treated as
 * sent (it replays on reconnect, deduped server-side via the idempotency key).
 */
export async function sendThenQueueOnOffline(opts: {
  send: () => Promise<unknown>;
  queue: () => Promise<unknown>;
}): Promise<'sent' | 'queued'> {
  try {
    await opts.send();
    return 'sent';
  } catch (err) {
    if (isNetworkError(err)) {
      await opts.queue();
      return 'queued';
    }
    throw err;
  }
}

/** Split a raw "a@b.com, c@d.com; e@f.com" string into trimmed, non-empty addresses. */
export function splitAddresses(raw: string): string[] {
  return raw.trim().split(ADDRESS_SEPARATOR).filter(Boolean);
}

/**
 * The chips plus whatever the user typed into the field but never committed
 * (no comma / return / suggestion tap). Typing `bob@x.com` and tapping Send
 * straight away is normal, so that address has to count as a recipient.
 */
export function withPendingInput(chips: string[], input: string): string[] {
  return [...chips, ...splitAddresses(input)];
}

/**
 * Resolve a required recipient list: prefer the chip array, else parse the raw
 * input. Always returns an array (possibly empty) — matches the old `to` logic.
 */
export function resolveRecipients(chips: string[], raw: string): string[] {
  return chips.length > 0 ? chips : splitAddresses(raw);
}

/**
 * Resolve an optional recipient list (cc/bcc): chips, else parsed raw input, else
 * `undefined` when the raw input is blank — matches the old cc/bcc logic.
 */
export function resolveOptionalRecipients(chips: string[], raw: string): string[] | undefined {
  if (chips.length > 0) return chips;
  return raw.trim() ? splitAddresses(raw) : undefined;
}

/**
 * Build the quoted "Original/Forwarded message" suffix appended to a reply or
 * forward body. Empty unless we're in a reply/forward with a quoted body.
 */
export function buildQuotedSuffix(
  composeMode: string | undefined,
  params: { quotedBody?: string; quotedFrom?: string; quotedSubject?: string },
): string {
  if (!composeMode || !params.quotedBody) return '';
  const label = composeMode === 'forward' ? 'Forwarded message' : 'Original message';
  return `\n\n---------- ${label} ---------\nFrom: ${params.quotedFrom || ''}\nSubject: ${
    params.quotedSubject || ''
  }\n\n${params.quotedBody}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The plain-text quoted suffix as HTML, for an HTML body. Appending the raw
 * text to HTML ran the quote together into one paragraph and let `<` in the
 * original (e.g. `Bob <bob@x.com>`) be parsed as a tag and stripped.
 */
export function quotedSuffixToHtml(quotedSuffix: string): string {
  if (!quotedSuffix) return '';
  return `<div>${escapeHtml(quotedSuffix).replace(/\r?\n/g, '<br>')}</div>`;
}

/**
 * Body fields for a saved draft: the composer's body is HTML once the rich
 * editor has been used, and must go in `htmlBody` or the web client shows the
 * raw markup as text.
 */
export function draftBodyFields(body: string | undefined, isHtml: boolean): { body?: string; htmlBody?: string } {
  if (!body) return {};
  return isHtml ? { htmlBody: body } : { body };
}

/** A pre-uploaded attachment reference, as returned by `uploadMailAttachments`. */
export interface UploadedAttachment {
  filename: string;
  contentType: string;
  size: number;
  fileKey: string;
}

export interface ComposePayloadInput {
  /** Recipient chips (preferred) + the raw "To" input (fallback). */
  toRecipients: string[];
  to: string;
  ccRecipients: string[];
  cc: string;
  bccRecipients: string[];
  bcc: string;
  subject: string;
  /** Plain-text body. */
  body: string;
  /** HTML body — when truthy, the message is sent as HTML. */
  bodyHtml: string;
  /** Quoted reply/forward suffix appended to the body (see buildQuotedSuffix). */
  quotedSuffix: string;
  /** SMTP Message-ID of the message being replied to, for threading. */
  inReplyTo?: string;
  /** References chain of the message being replied to (ends with inReplyTo). */
  references?: string[];
}

function composeBody(input: ComposePayloadInput): { useHtml: boolean; fullBody: string } {
  const useHtml = !!input.bodyHtml;
  const fullBody = useHtml
    ? input.bodyHtml + quotedSuffixToHtml(input.quotedSuffix)
    : input.body + input.quotedSuffix;
  return { useHtml, fullBody };
}

function threadingFields(input: ComposePayloadInput): { inReplyTo?: string; references?: string[] } {
  if (!input.inReplyTo) return {};
  return {
    inReplyTo: input.inReplyTo,
    references: input.references && input.references.length > 0 ? input.references : undefined,
  };
}

export interface SendPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body?: string;
  htmlBody?: string;
  attachments?: UploadedAttachment[];
  /** Idempotency key — makes a queued/retried send safe to replay (see outbox). */
  idempotencyKey?: string;
  inReplyTo?: string;
  references?: string[];
}

/**
 * Assemble the immediate-send payload for `mailAccounts.send`. Extracted from
 * `app/compose.tsx` handleSend so the to/cc/bcc + html-vs-text body shaping and
 * the attachment inclusion are unit-testable. Behaviour matches the previous
 * inline code exactly: in HTML mode `body` is omitted and `htmlBody` carries the
 * content; in plain mode it's the reverse. Subject defaults to "(No subject)".
 */
export function buildSendPayload(
  input: ComposePayloadInput,
  uploadedAttachments: UploadedAttachment[],
  idempotencyKey?: string,
): SendPayload {
  const { useHtml, fullBody } = composeBody(input);
  return {
    to: resolveRecipients(input.toRecipients, input.to),
    cc: resolveOptionalRecipients(input.ccRecipients, input.cc),
    bcc: resolveOptionalRecipients(input.bccRecipients, input.bcc),
    subject: input.subject.trim() || '(No subject)',
    body: useHtml ? undefined : fullBody || undefined,
    htmlBody: useHtml ? fullBody : undefined,
    attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    idempotencyKey,
    ...threadingFields(input),
  };
}

export interface ScheduledPayload {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  scheduledFor: string;
  inReplyTo?: string;
  references?: string[];
}

/**
 * Assemble the scheduled-send payload for `mailScheduled.schedule`. The body is
 * shaped like the immediate send (HTML in `htmlBody` only: the backend stores
 * `body` as the text part, so HTML there showed as raw markup in the plain-text
 * alternative). `subject` falls back to `undefined` (not "(No subject)").
 * Scheduled emails can't carry attachments, so none are included.
 */
export function buildScheduledPayload(
  input: ComposePayloadInput,
  accountId: string,
  scheduledForISO: string,
): ScheduledPayload {
  const { useHtml, fullBody } = composeBody(input);
  return {
    accountId,
    to: resolveRecipients(input.toRecipients, input.to),
    cc: resolveOptionalRecipients(input.ccRecipients, input.cc),
    bcc: resolveOptionalRecipients(input.bccRecipients, input.bcc),
    subject: input.subject.trim() || undefined,
    body: useHtml ? undefined : fullBody || undefined,
    htmlBody: useHtml ? fullBody : undefined,
    scheduledFor: scheduledForISO,
    ...threadingFields(input),
  };
}

export interface ContactSuggestion {
  id: string;
  email: string;
  name: string;
  company: string | null;
}

/**
 * Map a `/people` API response into composer contact suggestions. Extracted
 * verbatim from the two identical mapping blocks in compose's recent-contacts
 * load and the recipient-search debounce.
 */
export function mapContactSuggestions(data: any): ContactSuggestion[] {
  const contacts = data?.data ?? (Array.isArray(data) ? data : []);
  return contacts.map((c: any) => ({
    id: c.id,
    email: c.email || '',
    name: c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || '',
    company: c.company ?? null,
  }));
}
