import { useEffect } from 'react';
import { toast } from 'sonner';
import { useOtherActiveCall } from '@/contexts/active-call-context';
import { useCallSafe } from '@/contexts/call-context';
import { useHoldStaleChunkReload, useStaleChunkReloadState } from '@/hooks/use-hold-stale-chunk-reload';
import { useI18n } from '@/lib/i18n/provider';

const UPDATE_TOAST_ID = 'app-update-after-call';

/** Phone call states in which a reload would hang up on the other side. */
const LIVE_PHONE_STATUSES = new Set(['dialing', 'ringing', 'connected']);

/**
 * Keeps a new frontend version from reloading the page during a WeldChat
 * call, a WeldMeet meeting or a phone call: the reload waits until the call
 * ends (`lib/chunk-reload.ts`). Tells the user once when an update is waiting.
 * Mounted inside <ActiveCallProvider> and <CallProvider>.
 */
export function ReloadHoldDuringCalls() {
  const { t } = useI18n();
  const liveCall = useOtherActiveCall();
  const phoneStatus = useCallSafe()?.callState?.status;
  useHoldStaleChunkReload(!!liveCall || (!!phoneStatus && LIVE_PHONE_STATUSES.has(phoneStatus)));

  const { held, pending } = useStaleChunkReloadState();
  const waiting = held && pending;
  useEffect(() => {
    if (!waiting) return;
    toast.info(t.common.appUpdate.title, {
      id: UPDATE_TOAST_ID,
      description: t.common.appUpdate.reloadAfterCall,
      duration: 10_000,
    });
  }, [waiting, t]);

  return null;
}
