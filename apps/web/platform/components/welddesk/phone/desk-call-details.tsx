import { Button } from '@weldsuite/ui/components/button';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import type { InboundCallDetails } from '@/contexts/call-context';
import { useDeskTeams } from '@/hooks/queries/use-desk-routing-queries';
import { deskPhoneConversationPath, formatWait, secondsSince } from './desk-phone-events';

/**
 * Who an inbound WeldDesk call is, in the in-call panel: the customer, the
 * team, how long they waited, and a way back to the conversation.
 */
export function DeskCallDetails({
  details,
  answeredAt,
}: Readonly<{ details: InboundCallDetails; answeredAt: number }>) {
  const t = getTranslations('helpdesk').phone.inCall;
  const router = useRouter();
  const { data: teams } = useDeskTeams();
  const team = details.departmentId ? teams?.find((x) => x.id === details.departmentId)?.name : undefined;
  const waited = details.waitingSince ? formatWait(secondsSince(details.waitingSince, answeredAt)) : null;
  const conversationId = details.conversationId;
  if (!details.customerName && !team && !waited && !conversationId) return null;

  return (
    <div className="mb-4 w-full rounded-lg bg-muted/40 p-3 text-sm" data-testid="desk-call-details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {details.customerName && (
          <>
            <dt className="text-muted-foreground">{t.customer}</dt>
            <dd className="truncate text-right" data-testid="desk-call-details-customer">{details.customerName}</dd>
          </>
        )}
        {team && (
          <>
            <dt className="text-muted-foreground">{t.team}</dt>
            <dd className="truncate text-right" data-testid="desk-call-details-team">{team}</dd>
          </>
        )}
      </dl>
      {waited && <p className="mt-1 text-xs text-muted-foreground">{t.waited.replace('{time}', waited)}</p>}
      {conversationId && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full"
          onClick={() => router.push(deskPhoneConversationPath(conversationId))}
          data-testid="desk-call-details-open"
        >
          {t.openConversation}
        </Button>
      )}
    </div>
  );
}
