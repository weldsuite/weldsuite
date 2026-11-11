import { Loader2, Phone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { useCall } from '@/contexts/call-context';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import { useVoipPhoneNumbers } from '@/hooks/queries/use-voip-calls-queries';
import { usePerson } from '@/components/objects/person/use-person-data';
import { formatPhoneDisplay, useEnsureVoipReady, usePlaceCall } from '@/components/weldcrm/calls/call-dialing';
import { callableNumber, callerFromTimeline, pickOutboundNumber } from './desk-call-number';
import type { DeskMessage } from '@/hooks/queries/use-desk-queries';

/**
 * Click-to-call from a conversation: calls the customer from the workspace's
 * default number through the shared softphone, and logs the call on the
 * conversation's timeline. Shown only when there is a number to call and one
 * to call from.
 */
export function DeskCallButton({
  conversation,
  messages,
}: Readonly<{ conversation: DeskConversation; messages?: readonly DeskMessage[] }>) {
  const canCall = useCan('activities:create');
  if (!canCall) return null;
  return <CallButton conversation={conversation} messages={messages} />;
}

function CallButton({
  conversation,
  messages,
}: Readonly<{ conversation: DeskConversation; messages?: readonly DeskMessage[] }>) {
  const t = getTranslations('helpdesk').phone.call;
  const { callState } = useCall();
  const { data: numbers } = useVoipPhoneNumbers();
  const ensureReady = useEnsureVoipReady();
  const { isDialing, dial } = usePlaceCall();

  // A phone conversation is named after the number; otherwise the linked contact has one.
  const needsContact = !callableNumber(conversation, null, messages) && Boolean(conversation.contactId);
  const { data: person } = usePerson(conversation.contactId ?? '', needsContact);
  const toNumber = callableNumber(conversation, person?.data, messages);
  // Call back from the number the customer called, when it is one of ours.
  const calledNumber = conversation.channel === 'phone' ? callerFromTimeline(messages)?.toNumber : null;
  const fromNumber = pickOutboundNumber(numbers?.data, calledNumber);
  if (!toNumber || !fromNumber) return null;

  const place = async () => {
    if (!(await ensureReady())) {
      toast.error(t.notConnected);
      return;
    }
    await dial({ toNumber, fromNumber, enableRecording: true, deskConversationId: conversation.id });
  };

  const busy = isDialing || Boolean(callState);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 px-2 text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary"
      onClick={() => void place()}
      disabled={busy}
      title={t.title.replace('{number}', formatPhoneDisplay(toNumber))}
      aria-label={t.title.replace('{number}', formatPhoneDisplay(toNumber))}
      data-testid="desk-inbox-call"
    >
      {isDialing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
      <span className="hidden lg:inline">{t.button}</span>
    </Button>
  );
}
