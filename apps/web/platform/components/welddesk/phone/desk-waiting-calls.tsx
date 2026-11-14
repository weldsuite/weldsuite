import { useAtomValue } from 'jotai';
import { PhoneCall } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import {
  deskPhonePickupFailure,
  useDeskPhoneQueue,
  usePickupDeskPhoneCall,
  type DeskPhoneQueueItem,
} from '@/hooks/queries/use-desk-phone-queries';
import { useDeskTeams } from '@/hooks/queries/use-desk-routing-queries';
import { useNow } from '@/app/welddesk/inbox/sla-badge';
import { deskPhoneConversationPath, formatWait, secondsSince } from './desk-phone-events';
import { deskSoftphoneStatusAtom } from './desk-phone-state';

/** The wait so far, ticking each second. Its own component, so only this text re-renders. */
function WaitingFor({ since, template }: Readonly<{ since: string; template: string }>) {
  const now = useNow(1000);
  return <>{template.replace('{time}', formatWait(secondsSince(since, now)))}</>;
}

/**
 * Callers waiting for an agent, above the conversation list. Shown only while
 * there is someone waiting. Pick up rings this member's own browser for that
 * call; the incoming-call card appears when it does.
 */
export function DeskWaitingCalls() {
  const t = getTranslations('helpdesk').phone.waiting;
  const router = useRouter();
  const canUpdate = useCan('conversations:update');
  const { data: queue } = useDeskPhoneQueue(true);
  const { data: teams } = useDeskTeams();
  const pickup = usePickupDeskPhoneCall();
  const softphone = useAtomValue(deskSoftphoneStatusAtom);

  if (!queue || queue.length === 0) return null;

  // Picking up rings this browser: it has to be signed in to receive that.
  const softphoneReady = softphone === 'connected' || softphone === 'mic_blocked';
  const canPickUp = canUpdate && softphoneReady;

  const teamName = (item: DeskPhoneQueueItem) =>
    item.departmentId ? teams?.find((team) => team.id === item.departmentId)?.name : undefined;

  const pickUp = async (item: DeskPhoneQueueItem) => {
    try {
      await pickup.mutateAsync(item.callId);
      toast.success(t.pickedUp);
    } catch (err) {
      toast.error(t.errors[deskPhonePickupFailure(err)]);
    }
  };

  return (
    <section
      aria-label={t.title}
      className="flex-shrink-0 border-b border-gray-200 bg-muted/30 px-3 py-2 dark:border-border"
      data-testid="desk-waiting-calls"
    >
      <h2 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <PhoneCall className="h-3.5 w-3.5" />
        {t.title}
        <span className="rounded-full bg-muted px-1.5 text-[11px] text-foreground">{queue.length}</span>
      </h2>
      <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {queue.map((item) => {
          const team = teamName(item);
          const name = item.callerName || item.fromNumber || t.unknownCaller;
          const opens = item.conversationId;
          const details = [item.callerName ? item.fromNumber : null, team].filter(Boolean);
          return (
            <li
              key={item.callId}
              className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5 text-sm"
              data-testid="desk-waiting-call"
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left disabled:cursor-default"
                disabled={!opens}
                title={opens ? t.openConversation : undefined}
                onClick={() => opens && router.push(deskPhoneConversationPath(opens))}
                data-testid="desk-waiting-call-open"
              >
                <span className="block truncate font-medium">{name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {details.length > 0 && <>{details.join(' · ')} · </>}
                  <span data-testid="desk-waiting-call-time">
                    <WaitingFor since={item.waitingSince} template={t.waitingFor} />
                  </span>
                </span>
              </button>
              {item.ringing && (
                <SoftBadge tone="success" data-testid="desk-waiting-call-ringing">
                  {t.ringing}
                </SoftBadge>
              )}
              <Button
                size="sm"
                className="h-7"
                disabled={!canPickUp || pickup.isPending}
                onClick={() => void pickUp(item)}
                data-testid="desk-waiting-call-pickup"
              >
                {t.pickUp}
              </Button>
            </li>
          );
        })}
      </ul>
      {canUpdate && !softphoneReady && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="desk-waiting-calls-hint">
          {t.switchOnFirst}
        </p>
      )}
    </section>
  );
}
