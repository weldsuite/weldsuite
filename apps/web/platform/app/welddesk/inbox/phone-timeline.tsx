import { format } from 'date-fns';
import {
  Hash,
  Mic,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Voicemail,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import type { DeskMessage } from '@/hooks/queries/use-desk-queries';

/**
 * Phone events the call-api server writes into a conversation as system
 * messages (`metadata.event`), each with an icon. They read as centered
 * timeline lines, not as chat bubbles from an agent. The voice agent's
 * transcript turns (`ai_transcript`) are left as the bubbles they are.
 */
const PHONE_EVENT_ICONS: Record<string, LucideIcon> = {
  call_answered: PhoneIncoming,
  call_missed: PhoneMissed,
  call_outbound: PhoneOutgoing,
  call_ended: PhoneOff,
  menu_choice: Hash,
  menu_no_choice: Hash,
  recording_saved: Mic,
};

/** Whether a message is a phone event shown as a timeline line (or a voicemail). */
export function isPhoneTimelineMessage(message: DeskMessage): boolean {
  if (message.authorType !== 'system') return false;
  const event = message.metadata?.event;
  return event === 'voicemail' || (typeof event === 'string' && event in PHONE_EVENT_ICONS);
}

/** The recording link when it is a web address (it ends up in an audio element). */
export function safeRecordingUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null;
}

function durationSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function PhoneTimelineRow({ message }: Readonly<{ message: DeskMessage }>) {
  const t = getTranslations('helpdesk').phone.timeline;
  const time = format(new Date(message.createdAt), 'HH:mm');
  const event = String(message.metadata?.event ?? '');

  if (event === 'voicemail') {
    const url = safeRecordingUrl(message.metadata?.recordingUrl);
    const seconds = durationSeconds(message.metadata?.duration);
    return (
      <div className="mx-auto my-2 w-full max-w-sm px-4" data-testid="desk-inbox-voicemail">
        <div className="rounded-lg border bg-muted/40 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Voicemail className="h-3.5 w-3.5" />
            {t.voicemail}
            {seconds !== null && (
              <span className="font-normal text-muted-foreground" data-testid="desk-inbox-voicemail-length">
                · {t.voicemailLength.replace('{seconds}', String(seconds))}
              </span>
            )}
            <span className="ml-auto font-normal text-muted-foreground">{time}</span>
          </p>
          {url ? (
            <audio controls preload="none" src={url} className="h-9 w-full" data-testid="desk-inbox-voicemail-audio" />
          ) : (
            <p className="text-xs text-muted-foreground">{t.voicemailUnavailable}</p>
          )}
        </div>
      </div>
    );
  }

  const Icon = PHONE_EVENT_ICONS[event] ?? PhoneIncoming;
  return (
    <p
      className="flex items-center justify-center gap-1 px-4 py-2 text-center text-xs text-muted-foreground"
      data-testid="desk-inbox-phone-event"
      data-event={event}
    >
      <Icon className="h-3 w-3 flex-shrink-0" />
      {message.body} · {time}
    </p>
  );
}
