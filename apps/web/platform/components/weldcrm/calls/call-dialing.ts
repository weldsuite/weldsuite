import { useState, useEffect, useRef } from 'react';
import { useOrganization } from '@/lib/auth';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCall } from '@/contexts/call-context';
import { useFetchVoiceToken } from '@/hooks/queries';
import { useAppApiClient } from '@/lib/api/use-app-api';

// Dialing logic shared by the floating call panel and the WeldCall page dialer.

export type CallContextValue = ReturnType<typeof useCall>;
export type CallStateValue = NonNullable<CallContextValue['callState']>;
export type PhoneNumberOption = CallContextValue['phoneNumbers'][number];
export type TranslateFn = ReturnType<typeof useTranslations>;
type GetClientFn = ReturnType<typeof useAppApiClient>['getClient'];

export const DIAL_PAD_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export const MAX_PHONE_DIGITS = 15;

/** The WeldCall landing page shows a live call itself, so the floating panel stays out of the way there. */
export function isWeldCallDialerPath(pathname: string): boolean {
  return /^\/weldcall(\/new)?\/?$/.test(pathname);
}

export function formatPhoneDisplay(number: string): string {
  if (!number) return '';

  // If contains * or #, show as-is (DTMF characters)
  if (number.includes('*') || number.includes('#')) return number;

  // If starts with +, format internationally
  if (number.startsWith('+')) {
    const digits = number.slice(1).replaceAll(/\D/g, '');
    if (digits.length <= 2) return `+${digits}`;
    if (digits.length <= 5) return `+${digits.slice(0, 2)} ${digits.slice(2)}`;
    if (digits.length <= 8) return `+${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
    if (digits.length <= 11) return `+${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
    return `+${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 12)}`;
  }

  // Local format - group digits for readability
  const cleaned = number.replaceAll(/\D/g, '');
  if (cleaned.length <= 3) return cleaned;
  if (cleaned.length <= 6) return `${cleaned.slice(0, 3)} ${cleaned.slice(3)}`;
  if (cleaned.length <= 9) return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(6)}`;
  return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(6, 9)} ${cleaned.slice(9)}`;
}

// Detect country code from a phone number
function getCountryPrefix(number: string): string {
  if (number.startsWith('+1')) return '+1';
  if (number.startsWith('+44')) return '+44';
  if (number.startsWith('+31')) return '+31';
  if (number.startsWith('+49')) return '+49';
  if (number.startsWith('+33')) return '+33';
  if (number.startsWith('+32')) return '+32';
  if (number.startsWith('+')) return number.slice(0, 3);
  return '+31'; // Default to Netherlands
}

export function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function getStatusText(status: CallStateValue['status'] | undefined, duration: number, t: TranslateFn): string {
  switch (status) {
    case 'dialing':
      return t('sweep.weldcrm.globalCallPanel.statusDialing');
    case 'ringing':
      return t('sweep.weldcrm.globalCallPanel.statusRinging');
    case 'connected':
      return formatDuration(duration);
    case 'ended':
      return t('sweep.weldcrm.globalCallPanel.statusEnded');
    case 'failed':
      return t('sweep.weldcrm.globalCallPanel.statusFailed');
    default:
      return '';
  }
}

export function pickDefaultNumber(phoneNumbers: PhoneNumberOption[]): string | undefined {
  return phoneNumbers.find((p) => p.isDefault)?.phoneNumber || phoneNumbers[0]?.phoneNumber;
}

// Format the destination number - use country code from fromNumber if not specified
function formatDestinationNumber(toNumber: string, fromNumber: string): string {
  const digits = toNumber.replaceAll(/\D/g, '');
  return toNumber.startsWith('+') ? `+${digits}` : `${getCountryPrefix(fromNumber)}${digits}`;
}

// Preserve + at the start, allow digits, * and #. Returns null when the value has too many digits.
export function sanitizePhoneInput(val: string): string | null {
  const cleaned = val.startsWith('+')
    ? '+' + val.slice(1).replaceAll(/[^\d*#]/g, '')
    : val.replaceAll(/[^\d*#]/g, '');
  return cleaned.replaceAll(/\D/g, '').length > MAX_PHONE_DIGITS ? null : cleaned;
}

function callRecordErrorMessage(err: unknown, t: TranslateFn): string {
  const message = err instanceof Error ? err.message : '';
  return message.toLowerCase().includes('insufficient credits')
    ? t('sweep.weldcrm.globalCallPanel.notEnoughCredits')
    : t('sweep.weldcrm.globalCallPanel.failedToCreateCallRecord');
}

interface PlaceCallParams {
  toNumber: string;
  fromNumber: string;
  enableRecording: boolean;
  workspaceId: string | undefined;
  getClient: GetClientFn;
  startCall: CallContextValue['startCall'];
  t: TranslateFn;
}

async function placeCall({
  toNumber,
  fromNumber,
  enableRecording,
  workspaceId,
  getClient,
  startCall,
  t,
}: PlaceCallParams): Promise<void> {
  const formattedTo = formatDestinationNumber(toNumber, fromNumber);

  // First, create the call record in the database to get a callId. The
  // app-api pre-flights the prepaid credit balance here — an exhausted
  // wallet returns 402 INSUFFICIENT_CREDITS before any telephony spend.
  const client = await getClient();
  const initResult = await client.post<{ data?: { id: string } }>('/calls', {
    direction: 'outbound',
    fromNumber,
    toNumber: formattedTo,
    isRecorded: enableRecording,
    provider: 'telnyx',
  }).then(r => ({ success: !!r.data?.id, callId: r.data?.id, error: undefined as string | undefined }))
    .catch((err) => ({
      success: false,
      callId: undefined,
      error: callRecordErrorMessage(err, t),
    }));

  if (!initResult.success || !initResult.callId) {
    toast.error(initResult.error || t('sweep.weldcrm.globalCallPanel.failedToCreateCallRecord'));
    return;
  }

  // Now start the actual call with the callId
  const result = await startCall({
    toNumber: formattedTo,
    fromNumber,
    isRecording: enableRecording,
    workspaceId,
    callId: initResult.callId,
  });

  // On success keep the number for reference during the call
  if (!result.success) {
    toast.error(result.error || t('sweep.weldcrm.globalCallPanel.failedToStartCall'));
    console.error('[GlobalCallPanel] Call failed:', result.error);
  }
}

/** Creates the call record and starts the call; `isDialing` covers both steps. */
export function usePlaceCall() {
  const t = useTranslations();
  const { startCall } = useCall();
  const { getClient } = useAppApiClient();
  const { organization } = useOrganization();
  const [isDialing, setIsDialing] = useState(false);

  const dial = async (params: { toNumber: string; fromNumber: string; enableRecording: boolean }) => {
    if (!params.toNumber || !params.fromNumber) {
      toast.error(t('sweep.weldcrm.globalCallPanel.enterPhoneNumber'));
      return;
    }

    setIsDialing(true);

    try {
      await placeCall({ ...params, workspaceId: organization?.id, getClient, startCall, t });
    } catch (error) {
      console.error('[GlobalCallPanel] Call error:', error);
      const errorMessage = error instanceof Error ? error.message : t('sweep.weldcrm.globalCallPanel.failedToStartCall');
      toast.error(errorMessage);
    } finally {
      setIsDialing(false);
    }
  };

  return { isDialing, dial };
}

interface VoipInitParams {
  enabled: boolean;
  voipConfigured: boolean;
  isVoipReady: boolean;
  initializeVoip: CallContextValue['initializeVoip'];
  fetchVoiceToken: ReturnType<typeof useFetchVoiceToken>['mutateAsync'];
  t: TranslateFn;
}

// Initialize the voice SDK while a dialer is shown
export function useVoipInitialization({
  enabled,
  voipConfigured,
  isVoipReady,
  initializeVoip,
  fetchVoiceToken,
  t,
}: VoipInitParams) {
  const [isInitializing, setIsInitializing] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  // Bumped by resetInitialization so a retry re-runs the effect even when nothing else changed
  const [attempt, setAttempt] = useState(0);
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (!enabled || !voipConfigured || isVoipReady || hasInitialized.current) return;

    const initTwilio = async () => {
      hasInitialized.current = true;
      setIsInitializing(true);
      setInitError(null);
      try {
        const result = await fetchVoiceToken();
        const token = result?.token || result?.data?.token;
        if (token) {
          await initializeVoip(token);
        } else {
          console.warn('[Telnyx] Failed to get voice token:', result);
          setInitError(t('sweep.weldcrm.globalCallPanel.failedToGetVoiceToken'));
          hasInitialized.current = false;
        }
      } catch (error) {
        console.error('[Twilio] Initialization error:', error);
        setInitError(error instanceof Error ? error.message : t('sweep.weldcrm.globalCallPanel.initializationFailed'));
        hasInitialized.current = false; // Allow retry
      } finally {
        setIsInitializing(false);
      }
    };
    void initTwilio();
  }, [enabled, voipConfigured, isVoipReady, initializeVoip, fetchVoiceToken, t, attempt]);

  // Clears the error and lets the effect above initialize again
  const resetInitialization = () => {
    setInitError(null);
    hasInitialized.current = false;
    setAttempt((n) => n + 1);
  };

  return { isInitializing, initError, resetInitialization };
}
