/**
 * Names for the "switch call" dialog.
 *
 * The dialog reads "Leave {current} and join {target}?", so every label is a
 * noun phrase ("the call with Alice", "the meeting "Weekly sync"") built from
 * the `weldchat.switchCallDialog` templates. They are read when the dialog is
 * about to open, never at registration time, so they follow a language change.
 */

import { getTranslations } from '@/lib/i18n';

/** Whether the call is the one being left or the one being joined. */
export type CallLabelRole = 'current' | 'target';

function copy() {
  return getTranslations('weldchat').switchCallDialog;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

/** "the meeting "Weekly sync"", or a generic name when the title is not known. */
export function meetingCallLabel(title: string | null | undefined, role: CallLabelRole): string {
  const t = copy();
  if (title) return fill(t.meetingNamed, { title });
  return role === 'current' ? t.currentMeeting : t.newMeeting;
}

interface ChatCallLabelParts {
  role: CallLabelRole;
  /** The person (or people) in a DM / group DM call. */
  person?: string | null;
  /** The channel a call is in. */
  channelName?: string | null;
  /** Who is ringing, for an incoming call. */
  caller?: string | null;
}

/** "the call with Alice" / "the call in general" / "the call from Alice", or a generic name. */
export function chatCallLabel({ role, person, channelName, caller }: Readonly<ChatCallLabelParts>): string {
  const t = copy();
  if (caller) return fill(t.callFromPerson, { name: caller });
  if (person) return fill(t.callWithPerson, { name: person });
  if (channelName) return fill(t.callInChannel, { name: channelName });
  return role === 'current' ? t.currentCall : t.newCall;
}
