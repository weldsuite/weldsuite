import { useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { Phone, PhoneOff } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { useCallSafe, type AcceptIncomingError, type IncomingCallState, type InboundCallDetails } from '@/contexts/call-context';
import { useIsAppInstalled } from '@/hooks/use-is-app-installed';
import { useDeskTeams } from '@/hooks/queries/use-desk-routing-queries';
import { showOsNotification } from '@/lib/desktop-notifications';
import { playIncomingRingSound } from '@/lib/utils/notification-sound';
import { useNow } from '@/app/welddesk/inbox/sla-badge';
import {
  deskPhoneConversationPath,
  formatWait,
  secondsSince,
  type DeskPhoneEndedReason,
} from './desk-phone-events';
import { deskPhoneEndedAtom, deskPhoneIncomingAtom, type DeskPhoneIncoming } from './desk-phone-state';
import { useMicrophonePermission } from './use-microphone-permission';

type PhoneStrings = ReturnType<typeof getTranslations<'helpdesk'>>['phone'];

const RING_INTERVAL_MS = 2_600;
/** A ring that nobody answers goes quiet (the server stops ringing well before this). */
const RING_MAX_MS = 60_000;
/** How long "Answered by a colleague" stays up. */
const NOTICE_MS = 4_000;
/** The realtime event and the SDK's ring are the same call when they arrive this close together. */
const PAIRING_WINDOW_MS = 30_000;

/** The realtime caller details for the ring that is on screen, when they belong to it. */
export function pairIncoming(
  ring: Pick<IncomingCallState, 'receivedAt'> | null,
  event: DeskPhoneIncoming | null,
): DeskPhoneIncoming | null {
  if (!ring || !event) return null;
  return Math.abs(event.receivedAt - ring.receivedAt.getTime()) <= PAIRING_WINDOW_MS ? event : null;
}

/** The wait so far, ticking each second. Its own component, so nothing else re-renders with it. */
function WaitedFor({ since, template }: Readonly<{ since: string; template: string }>) {
  const now = useNow(1000);
  return <>{template.replace('{time}', formatWait(secondsSince(since, now)))}</>;
}

function acceptErrorMessage(error: AcceptIncomingError | undefined, t: PhoneStrings): string {
  switch (error) {
    case 'not_ringing':
      return t.incoming.errors.notRinging;
    case 'microphone_denied':
      return t.incoming.errors.microphoneDenied;
    case 'microphone_unavailable':
      return t.incoming.errors.microphoneUnavailable;
    case 'answer_failed':
      return t.incoming.errors.answerFailed;
    default:
      return t.incoming.acceptFailed;
  }
}

function endedMessage(reason: DeskPhoneEndedReason, t: PhoneStrings): string {
  switch (reason) {
    case 'answered_elsewhere':
      return t.incoming.endedAnsweredElsewhere;
    case 'caller_hung_up':
      return t.incoming.endedCallerHungUp;
    default:
      return t.incoming.endedTimeout;
  }
}

/**
 * The incoming-call card: who is ringing this browser (realtime caller
 * details next to the SDK's ring), with Accept and Decline, a ringtone, a tab
 * title cue and a desktop notification while the tab is in the background.
 * Mounted app-wide for members who can use the WeldDesk inbox.
 */
export function DeskIncomingCallCard() {
  const canRead = useCan('welddesk:conversations:read');
  const installed = useIsAppInstalled('welddesk');
  const call = useCallSafe();
  if (!canRead || !installed || !call) return null;
  return (
    <Card
      incomingCall={call.incomingCall}
      accept={call.acceptIncomingCall}
      decline={call.declineIncomingCall}
    />
  );
}

interface CardProps {
  incomingCall: IncomingCallState | null;
  accept: (details?: InboundCallDetails) => Promise<{ success: boolean; error?: AcceptIncomingError }>;
  decline: () => void;
}

function Card({ incomingCall, accept, decline }: Readonly<CardProps>) {
  const t = getTranslations('helpdesk').phone;
  const [event, setEvent] = useAtom(deskPhoneIncomingAtom);
  const ended = useAtomValue(deskPhoneEndedAtom);
  const { data: teams } = useDeskTeams();
  const { permission } = useMicrophonePermission();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const lastRingAt = useRef(0);
  const ringing = incomingCall !== null;

  const details = pairIncoming(incomingCall, event);
  if (ringing) lastRingAt.current = Date.now();

  // The ring: now, then every few seconds while the card is up.
  useEffect(() => {
    if (!ringing) return;
    playIncomingRingSound();
    const interval = setInterval(() => playIncomingRingSound(), RING_INTERVAL_MS);
    const quiet = setTimeout(() => clearInterval(interval), RING_MAX_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(quiet);
    };
  }, [ringing]);

  // A cue for a tab nobody is looking at: the title blinks, and a notification shows.
  const ringId = incomingCall?.id ?? null;
  const cueName = details?.callerName ?? details?.customerName ?? incomingCall?.callerName ?? incomingCall?.fromNumber;
  useEffect(() => {
    if (!ringId) return;
    const original = document.title;
    let flip = false;
    const blink = setInterval(() => {
      flip = !flip;
      document.title = document.hidden && flip ? t.incoming.titleCue : original;
    }, 1000);
    return () => {
      clearInterval(blink);
      document.title = original;
    };
  }, [ringId, t.incoming.titleCue]);

  useEffect(() => {
    if (!ringId) return;
    void showOsNotification({
      title: t.incoming.title,
      body: t.incoming.notificationBody.replace('{caller}', cueName || t.incoming.unknownCaller),
      silent: true,
      tag: 'desk-phone-incoming',
      dedupeKey: `desk-phone-incoming:${ringId}`,
      actionUrl: details?.conversationId ? deskPhoneConversationPath(details.conversationId) : undefined,
    });
    // One notification per ring: the caller's name arriving later does not repeat it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringId]);

  // `phone.ended` for the call on screen: drop the card and say why for a moment.
  useEffect(() => {
    if (!ended || !event || ended.callId !== event.callId) return;
    const onScreen = ringing || Date.now() - lastRingAt.current < NOTICE_MS;
    if (!onScreen) return;
    if (ringing) decline();
    setNotice(endedMessage(ended.reason, t));
    setEvent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleAccept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await accept(
        details
          ? {
              callId: details.callId,
              conversationId: details.conversationId,
              customerName: details.customerName,
              callerName: details.callerName,
              departmentId: details.departmentId,
              waitingSince: details.waitingSince,
            }
          : undefined,
      );
      if (result.success) setEvent(null);
      else toast.error(acceptErrorMessage(result.error, t));
    } finally {
      setBusy(false);
    }
  };

  if (!incomingCall) {
    if (!notice) return null;
    return (
      <div
        role="status"
        data-testid="desk-incoming-call-ended"
        className="fixed top-4 right-4 z-[70] w-80 rounded-lg border bg-background p-4 text-sm text-foreground shadow-lg animate-in fade-in-0 slide-in-from-top-2"
      >
        {notice}
      </div>
    );
  }

  const name = details?.callerName ?? details?.customerName ?? incomingCall.callerName ?? incomingCall.fromNumber;
  const number = details?.fromNumber || incomingCall.fromNumber;
  const customer = details?.customerName && details.customerName !== name ? details.customerName : null;
  const team = details?.departmentId ? teams?.find((x) => x.id === details.departmentId)?.name : undefined;

  return (
    <div
      role="alertdialog"
      aria-label={t.incoming.title}
      data-testid="desk-incoming-call"
      className="fixed top-4 right-4 z-[70] w-80 rounded-lg border bg-background p-4 text-foreground shadow-lg animate-in fade-in-0 slide-in-from-top-2"
    >
      <div className="flex items-center gap-3">
        <Avatar className="size-10">
          <AvatarFallback className="bg-muted text-muted-foreground">
            <Phone className="size-4" />
          </AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="text-xs text-muted-foreground">{t.incoming.title}</p>
          <p className="truncate text-sm leading-none font-medium" data-testid="desk-incoming-call-name">
            {name || t.incoming.unknownCaller}
          </p>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {customer && (
          <>
            <dt className="text-muted-foreground">{t.incoming.customer}</dt>
            <dd className="truncate text-right" data-testid="desk-incoming-call-customer">{customer}</dd>
          </>
        )}
        {number && (
          <>
            <dt className="text-muted-foreground">{t.incoming.number}</dt>
            <dd className="truncate text-right" data-testid="desk-incoming-call-number">{number}</dd>
          </>
        )}
        {team && (
          <>
            <dt className="text-muted-foreground">{t.incoming.team}</dt>
            <dd className="truncate text-right" data-testid="desk-incoming-call-team">{team}</dd>
          </>
        )}
      </dl>
      {details && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="desk-incoming-call-waited">
          <WaitedFor since={details.waitingSince} template={t.incoming.waited} />
        </p>
      )}
      {permission === 'denied' && (
        <InfoBanner variant="warning" className="mt-3">
          {t.incoming.micBlocked}
        </InfoBanner>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button variant="destructive" size="sm" data-testid="desk-incoming-call-decline" onClick={decline} disabled={busy}>
          <PhoneOff />
          {t.incoming.decline}
        </Button>
        <Button
          size="sm"
          className="bg-green-600 text-white hover:bg-green-700"
          data-testid="desk-incoming-call-accept"
          onClick={() => void handleAccept()}
          disabled={busy}
        >
          <Phone />
          {t.incoming.accept}
        </Button>
      </div>
    </div>
  );
}
