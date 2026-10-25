/**
 * The sentence for one entry of a request's activity. The server records the
 * facts (type, recipient, actor, details); the wording lives in the i18n
 * strings. A type this client does not know yet gives `null`, so the timeline
 * skips it instead of showing a blank row.
 */

import type { SignEventDto, SignEventType } from '@weldsuite/app-api-client/schemas/weldsign';

export interface ActivityStrings {
  someone: string;
  by: string;
  reason: string;
  events: Record<SignEventType, string>;
  remindedAutomatically: string;
  recipientCorrectedPlain: string;
  /** The signed PDF was also put on a CRM company or person. */
  filedWithCompany: string;
  filedWithPerson: string;
}

type Format = (template: string, values: Record<string, unknown>) => string;

export interface ActivityLine {
  /** The sentence ("Signed by Ann"). */
  text: string;
  /** A decline or void reason, shown under the sentence. */
  reason: string | null;
  /** The member who acted ("by Gert"), for events a member causes. */
  by: string | null;
}

/** Events a member causes; the others are the signer's own or the system's. */
const MEMBER_EVENTS: ReadonlySet<SignEventType> = new Set([
  'created',
  'sent',
  'reminded',
  'resent',
  'recipient_corrected',
  'voided',
  'downloaded',
]);

function detailText(details: SignEventDto['details'], key: string): string | null {
  const value = details?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function actorOf(event: SignEventDto): string | null {
  return event.actorName ?? event.actorEmail;
}

function template(event: SignEventDto, strings: ActivityStrings): string | undefined {
  // `events[type]` is undefined for a type added to the server after this client was built.
  const known = (strings.events as Partial<Record<string, string>>)[event.type];
  if (event.type === 'reminded' && !actorOf(event)) return strings.remindedAutomatically;
  if (event.type === 'recipient_corrected' && !(detailText(event.details, 'from') && detailText(event.details, 'to'))) {
    return strings.recipientCorrectedPlain;
  }
  if (event.type === 'filed') {
    // The server records what the signed PDF was filed on: a CRM company or person, besides WeldDrive.
    const record = detailText(event.details, 'recordType');
    if (record === 'company') return strings.filedWithCompany;
    if (record === 'person') return strings.filedWithPerson;
  }
  return known;
}

export function describeEvent(event: SignEventDto, strings: ActivityStrings, format: Format): ActivityLine | null {
  const text = template(event, strings);
  if (!text) return null;

  const actor = actorOf(event);
  const reason = detailText(event.details, 'reason');
  return {
    text: format(text, {
      name: event.recipientName ?? strings.someone,
      from: detailText(event.details, 'from') ?? '',
      to: detailText(event.details, 'to') ?? '',
    }),
    reason: reason ? format(strings.reason, { reason }) : null,
    by: actor && MEMBER_EVENTS.has(event.type) ? format(strings.by, { name: actor }) : null,
  };
}
