import { useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCan } from '@weldsuite/permissions/react';
import { useCallSafe } from '@/contexts/call-context';
import { useIsAppInstalled } from '@/hooks/use-is-app-installed';
import { useDeskSoftphone, useFetchDeskSoftphoneToken } from '@/hooks/queries/use-desk-phone-queries';
import { deskSoftphoneRetryAtom, deskSoftphoneStatusAtom, type DeskSoftphoneStatus } from './desk-phone-state';
import { useDeskPhoneRealtime } from './use-desk-phone-realtime';
import { useMicrophonePermission } from './use-microphone-permission';

/** Sign-ins in a row (without one reaching `ready`) before the bridge stops trying. */
export const MAX_SIGNIN_ATTEMPTS = 6;
/** A reconnect waits this long, doubling each time, so the SDK's own reconnect gets there first. */
export const SIGNIN_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;
/** A member-credential client that is still `connecting` after this long is dropped and rebuilt. */
export const CONNECT_WATCHDOG_MS = 20_000;

/** Waiting time before sign-in attempt number `attempts` (zero-based). */
export function signInDelay(attempts: number, hasMemberClient: boolean): number {
  if (attempts === 0 && !hasMemberClient) return 0;
  return Math.min(SIGNIN_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

/**
 * Makes this member's browser reachable for WeldDesk phone calls: while "take
 * calls" is on, the shared `CallProvider` client is signed in with the
 * member's own credential, and signed in again when the socket drops or the
 * login is refused (with a growing wait, and not forever). With the switch off
 * the client is left to WeldCall's shared login. Headless.
 */
export function DeskSoftphoneBridge() {
  const canRead = useCan('welddesk:conversations:read');
  const installed = useIsAppInstalled('welddesk');
  if (!canRead || !installed) return null;
  return <ActiveBridge />;
}

function ActiveBridge() {
  useDeskPhoneRealtime();
  const call = useCallSafe();
  const { data: softphone } = useDeskSoftphone(true);
  const fetchToken = useFetchDeskSoftphoneToken();
  const { permission } = useMicrophonePermission();
  const retryRequest = useAtomValue(deskSoftphoneRetryAtom);
  const setStatus = useSetAtom(deskSoftphoneStatusAtom);

  const attempts = useRef(0);
  const lastRetry = useRef(retryRequest);
  // Bumped when an attempt ends without a connection change that would re-run the effect.
  const [tick, setTick] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);

  const configured = softphone?.configured ?? false;
  const available = configured && (softphone?.available ?? false);
  const credential = call?.voipCredential ?? null;
  const connection = call?.voipConnection ?? 'idle';
  const busy = Boolean(call?.callState || call?.incomingCall);
  const initializeVoip = call?.initializeVoip;
  const resetVoip = call?.resetVoip;
  const mintToken = fetchToken.mutateAsync;

  // Starting over: the switch toggled, or "try again" was pressed.
  useEffect(() => {
    attempts.current = 0;
    setGaveUp(false);
  }, [available]);
  useEffect(() => {
    if (lastRetry.current === retryRequest) return;
    lastRetry.current = retryRequest;
    attempts.current = 0;
    setGaveUp(false);
    setTick((n) => n + 1);
  }, [retryRequest]);

  useEffect(() => {
    if (!initializeVoip || !resetVoip) return;

    if (!available) {
      // Switched off: let go of the member's own login, but never in the middle of a call.
      if (credential === 'member' && !busy) resetVoip();
      return;
    }

    if (credential === 'member' && connection === 'ready') {
      attempts.current = 0;
      return;
    }

    if (credential === 'member' && connection === 'connecting') {
      // Never reaching ready is a failed attempt, not a reason to wait forever.
      const watchdog = setTimeout(() => {
        attempts.current += 1;
        resetVoip();
      }, CONNECT_WATCHDOG_MS);
      return () => clearTimeout(watchdog);
    }

    // A call in progress keeps its client, whoever's login it has.
    if (busy && credential !== null) return;
    if (attempts.current >= MAX_SIGNIN_ATTEMPTS) {
      setGaveUp(true);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      attempts.current += 1;
      try {
        const minted = await mintToken();
        if (cancelled) return;
        if (!minted.token) throw new Error('No softphone token');
        await initializeVoip(minted.token, { credential: 'member' });
      } catch (error) {
        console.error('[DeskPhone] Softphone sign-in failed:', error);
        if (!cancelled) setTick((n) => n + 1);
      }
    }, signInDelay(attempts.current, credential === 'member'));

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [available, credential, connection, busy, initializeVoip, resetVoip, mintToken, tick]);

  let status: DeskSoftphoneStatus;
  if (!softphone) status = 'off';
  else if (!configured) status = 'not_configured';
  else if (!available) status = 'off';
  else if (gaveUp) status = 'failed';
  else if (credential === 'member' && connection === 'ready') status = permission === 'denied' ? 'mic_blocked' : 'connected';
  else status = 'connecting';

  useEffect(() => {
    setStatus(status);
  }, [status, setStatus]);

  return null;
}
