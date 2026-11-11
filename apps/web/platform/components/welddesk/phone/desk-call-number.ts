/**
 * Which number a WeldDesk conversation can be called on, and which of the
 * workspace's numbers to call from. The conversation itself carries no phone
 * field: a phone-channel conversation is named after the caller's number, and
 * any other has the number of its linked contact.
 */

import type { DeskChannel } from '@/hooks/queries/use-desk-queries';

interface CallableConversation {
  channel: DeskChannel;
  name: string | null;
}

interface CallableContact {
  mobilePhone?: string | null;
  directPhone?: string | null;
}

interface OutboundNumberOption {
  phoneNumber: string;
  isDefault?: boolean;
  status?: string;
  allowOutbound?: boolean;
}

const PHONE_LIKE = /^\+?[\d\s().-]{6,}$/;
const MIN_DIGITS = 6;

/** A phone number reduced to what the dialer takes: digits, with a leading `+` kept. */
export function dialableNumber(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !PHONE_LIKE.test(trimmed)) return null;
  const digits = trimmed.replaceAll(/\D/g, '');
  if (digits.length < MIN_DIGITS) return null;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

interface TimelineMessage {
  metadata?: Record<string, unknown> | null;
}

/** The caller's number (and the number they called) from the newest timeline message that carries a valid `fromNumber`. */
export function callerFromTimeline(
  messages: readonly TimelineMessage[] | undefined,
): { fromNumber: string; toNumber: string | null } | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const metadata = messages?.[i]?.metadata;
    const fromNumber = typeof metadata?.fromNumber === 'string' ? dialableNumber(metadata.fromNumber) : null;
    if (fromNumber) {
      const toNumber = typeof metadata?.toNumber === 'string' ? dialableNumber(metadata.toNumber) : null;
      return { fromNumber, toNumber };
    }
  }
  return null;
}

/**
 * The number to call for a conversation, or null when there is none to be found.
 * For a phone conversation, in order: the caller number on the timeline, the
 * name when it is a number, then the linked contact's phone.
 */
export function callableNumber(
  conversation: CallableConversation,
  contact: CallableContact | null | undefined,
  messages?: readonly TimelineMessage[],
): string | null {
  const isPhone = conversation.channel === 'phone';
  const fromTimeline = isPhone ? (callerFromTimeline(messages)?.fromNumber ?? null) : null;
  const fromName = isPhone ? dialableNumber(conversation.name) : null;
  return fromTimeline ?? fromName ?? dialableNumber(contact?.mobilePhone) ?? dialableNumber(contact?.directPhone);
}

function digitsOf(value: string): string {
  return value.replaceAll(/\D/g, '');
}

/** The workspace number to call from: the default one when it may call out, else the first that may. */
export function pickOutboundNumber(
  numbers: readonly OutboundNumberOption[] | undefined,
  /** The number the customer called, used when it is one of the usable numbers. */
  preferred?: string | null,
): string | null {
  const usable = (numbers ?? []).filter((n) => (!n.status || n.status === 'active') && n.allowOutbound !== false);
  const wanted = preferred ? digitsOf(preferred) : '';
  const called = wanted ? usable.find((n) => digitsOf(n.phoneNumber) === wanted) : undefined;
  if (called) return called.phoneNumber;
  return (usable.find((n) => n.isDefault) ?? usable[0])?.phoneNumber ?? null;
}
