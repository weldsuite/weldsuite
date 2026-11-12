import { useAtomValue, useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { Phone } from 'lucide-react';
import { Switch } from '@weldsuite/ui/components/switch';
import { Button } from '@weldsuite/ui/components/button';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { useDeskSoftphone, useSetDeskSoftphoneAvailable } from '@/hooks/queries/use-desk-phone-queries';
import { deskSoftphoneRetryAtom, deskSoftphoneStatusAtom, type DeskSoftphoneStatus } from './desk-phone-state';
import { useMicrophonePermission } from './use-microphone-permission';

/**
 * "Take calls": whether this member's browser rings for WeldDesk phone calls,
 * with where the softphone stands next to it. Hidden when telephony is not set
 * up for the deployment. The softphone itself is signed in by the app-wide
 * `DeskSoftphoneBridge`; this only flips the switch and shows its state.
 */
export function DeskTakeCallsSwitch() {
  const t = getTranslations('helpdesk').phone.takeCalls;
  const canUpdate = useCan('conversations:update');
  const { data: softphone } = useDeskSoftphone(true);
  const setAvailable = useSetDeskSoftphoneAvailable();
  const status = useAtomValue(deskSoftphoneStatusAtom);
  const retry = useSetAtom(deskSoftphoneRetryAtom);
  const { request: requestMicrophone } = useMicrophonePermission();

  if (!softphone?.configured) return null;
  const available = softphone.available;

  const change = async (next: boolean) => {
    // Ask for the microphone now, while nobody is waiting on this member.
    if (next && !(await requestMicrophone())) toast.warning(t.micBlockedToast);
    try {
      await setAvailable.mutateAsync(next);
    } catch {
      toast.error(t.updateError);
    }
  };

  return (
    <div
      className="flex h-8 items-center gap-2 rounded-md border px-2.5 text-sm"
      title={t.hint}
      data-testid="desk-take-calls"
    >
      <Phone className="h-3.5 w-3.5 text-muted-foreground" />
      <label htmlFor="desk-take-calls-switch" className="cursor-pointer whitespace-nowrap">
        {t.label}
      </label>
      <Switch
        id="desk-take-calls-switch"
        checked={available}
        onCheckedChange={(next) => void change(next)}
        disabled={!canUpdate || setAvailable.isPending}
        data-testid="desk-take-calls-switch"
      />
      {available && <StatusLabel status={status} />}
      {available && status === 'failed' && (
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0"
          onClick={() => retry((n) => n + 1)}
          data-testid="desk-take-calls-retry"
        >
          {t.retry}
        </Button>
      )}
    </div>
  );
}

function StatusLabel({ status }: Readonly<{ status: DeskSoftphoneStatus }>) {
  const t = getTranslations('helpdesk').phone.takeCalls;
  switch (status) {
    case 'connected':
      return <SoftBadge tone="success" data-testid="desk-take-calls-status">{t.statusConnected}</SoftBadge>;
    case 'mic_blocked':
      return <SoftBadge tone="warning" data-testid="desk-take-calls-status">{t.statusMicBlocked}</SoftBadge>;
    case 'failed':
      return <SoftBadge tone="danger" data-testid="desk-take-calls-status">{t.statusFailed}</SoftBadge>;
    case 'connecting':
      return <SoftBadge tone="neutral" data-testid="desk-take-calls-status">{t.statusConnecting}</SoftBadge>;
    default:
      return null;
  }
}
