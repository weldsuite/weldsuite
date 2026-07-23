
import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Phone,
  PhoneCall,
  PhoneOff,
  X,
  Minus,
  Maximize,
  Mic,
  MicOff,
  User,
  Delete,
  Pause,
  Play,
  Loader2,
  Volume2,
  Hash,
  RefreshCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCall } from '@/contexts/call-context';
import { useComposeSafe } from '@/contexts/compose-context';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { toast } from 'sonner';
import { useFetchVoiceToken } from '@/hooks/queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useOrganization } from '@clerk/clerk-react';
import { useTranslations } from '@weldsuite/i18n/client';

function formatPhoneDisplay(number: string): string {
  if (!number) return '';

  // If contains * or #, show as-is (DTMF characters)
  if (number.includes('*') || number.includes('#')) return number;

  // If starts with +, format internationally
  if (number.startsWith('+')) {
    const digits = number.slice(1).replace(/\D/g, '');
    if (digits.length <= 2) return `+${digits}`;
    if (digits.length <= 5) return `+${digits.slice(0, 2)} ${digits.slice(2)}`;
    if (digits.length <= 8) return `+${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
    if (digits.length <= 11) return `+${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
    return `+${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 12)}`;
  }

  // Local format - group digits for readability
  const cleaned = number.replace(/\D/g, '');
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

function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function GlobalCallPanel() {
  const t = useTranslations();
  const {
    isDialerOpen,
    setIsDialerOpen,
    callState,
    startCall,
    endCall,
    dismissCall,
    toggleMute,
    toggleHold,
    sendDigits,
    isMinimized,
    setIsMinimized,
    phoneNumbers,
    voipConfigured,
    initializeVoip,
    resetVoip,
    isVoipReady,
    initialDialerNumber,
    setInitialDialerNumber,
  } = useCall();

  const { getClient } = useAppApiClient();
  const { mutateAsync: fetchVoiceToken } = useFetchVoiceToken();
  const composeContext = useComposeSafe();
  const mobileNav = useMobileNavOptional();
  const agentRight = mobileNav?.showWeldAgent ? `${(mobileNav?.weldAgentWidth ?? 480) + 16}px` : '16px';
  const { organization } = useOrganization();
  const workspaceId = organization?.id;

  const [toNumber, setToNumber] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const [enableRecording, setEnableRecording] = useState(true);
  const [duration, setDuration] = useState(0);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isDialing, setIsDialing] = useState(false);
  const [showDtmfPad, setShowDtmfPad] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [mounted, setMounted] = useState(false);
  const hasInitialized = useRef(false);
  const zeroLongPress = useRef(false);
  const zeroPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDismissing, setIsDismissing] = useState(false);

  // Only one floating panel at a time: close compose when dialer opens
  useEffect(() => {
    if (isDialerOpen && composeContext?.isComposeOpen) {
      composeContext.closeCompose();
    }
  }, [isDialerOpen]);

  // Pre-fill dialer number when opened with a number
  useEffect(() => {
    if (isDialerOpen && initialDialerNumber) {
      setToNumber(initialDialerNumber);
      setInitialDialerNumber('');
    }
  }, [isDialerOpen, initialDialerNumber, setInitialDialerNumber]);

  // Initialize Twilio Voice SDK when dialer opens
  useEffect(() => {
    if (isDialerOpen && voipConfigured && !isVoipReady && !hasInitialized.current) {
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
      initTwilio();
    }
  }, [isDialerOpen, voipConfigured, isVoipReady, initializeVoip]);

  // Function to reset and reinitialize
  const handleResetTwilio = async () => {
    setInitError(null);
    resetVoip();
    hasInitialized.current = false;
    // Will reinitialize on next render due to useEffect
  };

  // Set default from number when phone numbers change
  useEffect(() => {
    if (phoneNumbers.length > 0 && !fromNumber) {
      const defaultNumber = phoneNumbers.find(p => p.isDefault)?.phoneNumber || phoneNumbers[0]?.phoneNumber;
      if (defaultNumber) setFromNumber(defaultNumber);
    }
  }, [phoneNumbers, fromNumber]);

  // Duration timer when connected
  useEffect(() => {
    if (callState?.status === 'connected') {
      durationIntervalRef.current = setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);
    } else {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      if (!callState) {
        setDuration(0);
      }
    }

    return () => {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
      }
    };
  }, [callState?.status]);

  // Close dialer when call ends so it doesn't revert to "Make a Call"
  // Start dismiss animation 250ms before the 2s auto-clear in endCall
  useEffect(() => {
    if (callState?.status === 'ended') {
      setIsDialerOpen(false);
      setToNumber('');
      const timer = setTimeout(() => {
        setIsDismissing(true);
      }, 1750);
      return () => clearTimeout(timer);
    } else {
      setIsDismissing(false);
    }
  }, [callState?.status, setIsDialerOpen]);

  // Prevent page refresh/close during an active call
  useEffect(() => {
    if (callState && callState.status !== 'ended') {
      const handleBeforeUnload = (e: BeforeUnloadEvent) => {
        e.preventDefault();
      };
      window.addEventListener('beforeunload', handleBeforeUnload);
      return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }
  }, [callState, callState?.status]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleNumberClick = (digit: string) => {
    // During a connected call, send as DTMF
    if (callState?.status === 'connected') {
      sendDigits(digit);
    } else {
      setToNumber(prev => {
        const digits = prev.replace(/\D/g, '');
        if (digits.length >= 15) return prev;
        return prev + digit;
      });
    }
  };

  const handleBackspace = () => {
    setToNumber(prev => prev.slice(0, -1));
  };

  const handleCall = async () => {
    if (!toNumber || !fromNumber) {
      toast.error(t('sweep.weldcrm.globalCallPanel.enterPhoneNumber'));
      return;
    }

    // Format the destination number - use country code from fromNumber if not specified
    let formattedTo = toNumber.replace(/\D/g, '');
    if (!toNumber.startsWith('+')) {
      const countryPrefix = getCountryPrefix(fromNumber);
      formattedTo = `${countryPrefix}${formattedTo}`;
    } else {
      formattedTo = `+${formattedTo}`;
    }

    setIsDialing(true);

    try {
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
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : '';
          return {
            success: false,
            callId: undefined,
            error: message.toLowerCase().includes('insufficient credits')
              ? t('sweep.weldcrm.globalCallPanel.notEnoughCredits')
              : t('sweep.weldcrm.globalCallPanel.failedToCreateCallRecord'),
          };
        });

      if (!initResult.success || !initResult.callId) {
        toast.error(initResult.error || t('sweep.weldcrm.globalCallPanel.failedToCreateCallRecord'));
        setIsDialing(false);
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

      if (result.success) {
        // Don't clear the number - keep it for reference during the call
      } else {
        toast.error(result.error || t('sweep.weldcrm.globalCallPanel.failedToStartCall'));
        console.error('[GlobalCallPanel] Call failed:', result.error);
      }
    } catch (error) {
      console.error('[GlobalCallPanel] Call error:', error);
      const errorMessage = error instanceof Error ? error.message : t('sweep.weldcrm.globalCallPanel.failedToStartCall');
      toast.error(errorMessage);
    } finally {
      setIsDialing(false);
    }
  };

  const handleEndCall = () => {
    endCall();
    setToNumber('');
  };

  const handleClose = () => {
    if (callState && callState.status !== 'ended') {
      toast.error(t('sweep.weldcrm.globalCallPanel.endCallFirst'));
      return;
    }
    setIsDialerOpen(false);
    setToNumber('');
  };

  const dialPadButtons = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['*', '0', '#'],
  ];

  const getStatusText = () => {
    switch (callState?.status) {
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
  };

  const getStatusColor = () => {
    switch (callState?.status) {
      case 'dialing':
      case 'ringing':
        return 'text-yellow-500';
      case 'connected':
        return 'text-green-500';
      case 'ended':
      case 'failed':
        return 'text-red-500';
      default:
        return 'text-muted-foreground';
    }
  };

  if (!mounted || (!isDialerOpen && !callState)) return null;

  const isMinimizedCall = !!(callState && isMinimized);

  // Single panel that transitions between minimized and expanded
  const panel = (
    <div
      className="bg-background fixed z-50 rounded-lg flex flex-col overflow-hidden bottom-4"
      style={{
        right: agentRight,
        width: isMinimizedCall ? '280px' : '340px',
        maxWidth: '90vw',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.03)',
        opacity: isDismissing ? 0 : 1,
        transform: isDismissing ? 'scale(0.95) translateY(8px)' : 'scale(1) translateY(0)',
        transition: 'width 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 250ms ease-out, transform 250ms ease-out',
      }}
    >
      {/* Minimized bar */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out"
        style={{
          gridTemplateRows: isMinimizedCall ? '1fr' : '0fr',
          opacity: isMinimizedCall ? 1 : 0,
        }}
      >
        <div className="overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          {/* Call info */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {callState?.contactName || formatPhoneDisplay(callState?.toNumber || '')}
            </p>
            <p className={cn("text-xs", getStatusColor())}>
              {getStatusText()}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1">
            {callState?.status === 'connected' && (
              <Button
                variant="ghost"
                onClick={toggleMute}
                className={cn(
                  "rounded-md p-2 transition-colors",
                  callState.isMuted
                    ? "bg-red-100 text-red-600"
                    : "hover:bg-gray-100 text-gray-600"
                )}
                title={callState.isMuted ? t('sweep.weldcrm.globalCallPanel.unmute') : t('sweep.weldcrm.globalCallPanel.mute')}
              >
                {callState.isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </Button>
            )}
            {callState?.status !== 'ended' && (
              <Button
                variant="ghost"
                onClick={() => setIsMinimized(false)}
                className="rounded-md p-2 hover:bg-gray-100 text-gray-600 transition-colors"
                title={t('sweep.weldcrm.globalCallPanel.expand')}
              >
                <Maximize className="h-4 w-4" />
              </Button>
            )}
            {callState?.status !== 'ended' && (
              <Button
                variant="ghost"
                onClick={handleEndCall}
                className="rounded-md p-2 bg-red-100 text-red-600 hover:bg-red-200 transition-colors"
                title={t('sweep.weldcrm.globalCallPanel.endCall')}
              >
                <PhoneOff className="h-4 w-4" />
              </Button>
            )}
            {callState?.status === 'ended' && (
              <Button
                variant="ghost"
                onClick={() => {
                  setIsDismissing(true);
                  setTimeout(() => {
                    dismissCall();
                    setIsDismissing(false);
                  }, 250);
                }}
                className="rounded-md p-2 hover:bg-gray-100 text-gray-600 transition-colors"
                title={t('sweep.weldcrm.globalCallPanel.close')}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        </div>
      </div>

      {/* Expanded content */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out"
        style={{
          gridTemplateRows: isMinimizedCall ? '0fr' : '1fr',
          opacity: isMinimizedCall ? 0 : 1,
        }}
      >
      <div className="overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div>
            <h3 className="text-sm font-semibold">
              {callState ? t('sweep.weldcrm.globalCallPanel.activeCall') : t('sweep.weldcrm.globalCallPanel.makeACall')}
            </h3>
          </div>
        </div>
        <div className="flex items-center gap-1 -mr-1.5">
          {callState && (
            <Button
              variant="ghost"
              onClick={() => setIsMinimized(true)}
              className="rounded-md p-2 text-gray-500 transition-colors hover:text-gray-900 hover:bg-gray-100"
              title={t('sweep.weldcrm.globalCallPanel.minimize')}
            >
              <Minus className="h-4 w-4" />
            </Button>
          )}
          {!callState && (
            <Button
              variant="ghost"
              onClick={handleClose}
              className="rounded-md p-2 text-gray-500 transition-colors hover:text-gray-900 hover:bg-gray-100"
              title={t('sweep.weldcrm.globalCallPanel.close')}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Active call view */}
      {callState && callState.status !== 'ended' ? (
        <div className="p-6 flex flex-col items-center">
          {/* Contact avatar */}
          <div className="w-20 h-20 rounded-3xl bg-gray-100 flex items-center justify-center mb-4">
            <User className="h-10 w-10 text-gray-400" />
          </div>

          {/* Phone number */}
          <p className="text-lg font-medium mb-1">
            {callState.contactName || formatPhoneDisplay(callState.toNumber)}
          </p>
          <p className={cn("text-sm mb-4", getStatusColor())}>
            {getStatusText()}
          </p>

          {/* Recording indicator */}
          {callState.isRecording && callState.status === 'connected' && (
            <div className="flex items-center gap-2 mb-4 px-3 py-1.5 bg-red-50 rounded-lg">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs text-red-600 font-medium">{t('sweep.weldcrm.globalCallPanel.recording')}</span>
            </div>
          )}

          {/* Hold indicator */}
          {callState.isOnHold && callState.status === 'connected' && (
            <div className="flex items-center gap-2 mb-4 px-3 py-1.5 bg-yellow-50 rounded-lg">
              <Pause className="h-3 w-3 text-yellow-600" />
              <span className="text-xs text-yellow-600 font-medium">{t('sweep.weldcrm.globalCallPanel.onHold')}</span>
            </div>
          )}

          {/* Call controls */}
          <div className="flex items-center gap-3 flex-wrap justify-center">
            {callState.status === 'connected' && (
              <>
                <Button
                  variant="ghost"
                  onClick={toggleMute}
                  className={cn(
                    "w-12 h-12 rounded-lg flex items-center justify-center transition-colors",
                    callState.isMuted
                      ? "bg-red-100 text-red-600"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  )}
                  title={callState.isMuted ? t('sweep.weldcrm.globalCallPanel.unmute') : t('sweep.weldcrm.globalCallPanel.mute')}
                >
                  {callState.isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </Button>
                <Button
                  variant="ghost"
                  onClick={toggleHold}
                  className={cn(
                    "w-12 h-12 rounded-lg flex items-center justify-center transition-colors",
                    callState.isOnHold
                      ? "bg-yellow-100 text-yellow-600"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  )}
                  title={callState.isOnHold ? t('sweep.weldcrm.globalCallPanel.resume') : t('sweep.weldcrm.globalCallPanel.hold')}
                >
                  {callState.isOnHold ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setShowDtmfPad(!showDtmfPad)}
                  className={cn(
                    "w-12 h-12 rounded-lg flex items-center justify-center transition-colors",
                    showDtmfPad
                      ? "bg-blue-100 text-blue-600"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  )}
                  title={t('sweep.weldcrm.globalCallPanel.keypad')}
                >
                  <Hash className="h-5 w-5" />
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              onClick={handleEndCall}
              className="w-12 h-12 rounded-lg bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors"
              title={t('sweep.weldcrm.globalCallPanel.endCall')}
            >
              <PhoneOff className="h-6 w-6" />
            </Button>
          </div>

          {/* DTMF Keypad during call */}
          {showDtmfPad && callState.status === 'connected' && (
            <div className="mt-4 grid grid-cols-3 gap-2">
              {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['*', '0', '#']].map((row) =>
                row.map((digit) => (
                  <Button
                    key={digit}
                    variant="outline"
                    size="sm"
                    className="h-10 w-14 text-lg font-medium active:bg-gray-200 transition-colors duration-300"
                    onClick={() => handleNumberClick(digit)}
                  >
                    {digit}
                  </Button>
                ))
              )}
            </div>
          )}
        </div>
      ) : phoneNumbers.length === 0 ? (
        /* No phone numbers configured - match dialer height */
        <div className="p-4 flex flex-col items-center justify-center text-center" style={{ minHeight: '540px' }}>
          <h4 className="text-sm font-medium text-gray-900 dark:text-foreground mb-1">{t('sweep.weldcrm.globalCallPanel.noPhoneNumberConnected')}</h4>
          <p className="text-xs text-gray-500 mb-4">
            {t('sweep.weldcrm.globalCallPanel.noPhoneNumberDescription')}
          </p>
          <Button
            size="sm"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => {
              setIsDialerOpen(false);
              window.location.href = '/settings/apps/phone-numbers';
            }}
          >
            {t('sweep.weldcrm.globalCallPanel.configureNumber')}
          </Button>
        </div>
      ) : (
        /* Dialer view */
        <div className="p-4 space-y-4">
          {/* From Number Selection */}
          <div className="space-y-2">
            <Select value={fromNumber} onValueChange={setFromNumber}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder={t('sweep.weldcrm.globalCallPanel.selectANumber')} />
              </SelectTrigger>
              <SelectContent>
                {phoneNumbers.map((phone) => (
                  <SelectItem key={phone.id} value={phone.phoneNumber}>
                    {phone.formattedNumber || phone.phoneNumber}
                    {phone.displayName && ` - ${phone.displayName}`}
                    {phone.isDefault && ` (${t('sweep.weldcrm.globalCallPanel.default')})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Initialization Error */}
          {initError && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
              <p className="text-sm text-red-800 dark:text-red-200 mb-2">{initError}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetTwilio}
                className="text-red-700 border-red-300 hover:bg-red-100"
              >
                <RefreshCcw className="h-3 w-3 mr-1" />
                {t('sweep.weldcrm.globalCallPanel.retryConnection')}
              </Button>
            </div>
          )}

          {/* Initializing indicator */}
          {isInitializing && (
            <div className="flex items-center justify-center gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
              <span className="text-sm text-blue-800 dark:text-blue-200">{t('sweep.weldcrm.globalCallPanel.connectingToPhoneService')}</span>
            </div>
          )}

          {/* Phone Number Display */}
          <div className="relative">
            <Input
              type="tel"
              value={formatPhoneDisplay(toNumber)}
              onChange={(e) => {
                const val = e.target.value;
                let cleaned: string;
                // Preserve + at the start, allow digits, * and #
                if (val.startsWith('+')) {
                  cleaned = '+' + val.slice(1).replace(/[^\d*#]/g, '');
                } else {
                  cleaned = val.replace(/[^\d*#]/g, '');
                }
                const digits = cleaned.replace(/\D/g, '');
                if (digits.length > 15) return;
                setToNumber(cleaned);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && toNumber && fromNumber && !isDialing && !isInitializing) {
                  e.preventDefault();
                  handleCall();
                }
              }}
              placeholder="+31 6 1234 5678"
              className="text-xl text-center font-mono h-12 px-10"
              autoFocus
              ref={(el) => { if (el) el.focus(); }}
            />
            {toNumber && (
              <Button
                variant="ghost"
                onClick={handleBackspace}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
              >
                <Delete className="h-5 w-5" />
              </Button>
            )}
          </div>

          {/* Dial Pad */}
          <div className="grid grid-cols-3 gap-2">
            {dialPadButtons.map((row) => (
              row.map((digit) => {
                if (digit === '0') {
                  // Long-press on 0 types +
                  return (
                    <Button
                      key={digit}
                      variant="outline"
                      className="h-12 text-lg font-medium hover:bg-gray-50 active:bg-gray-200 transition-colors duration-300 flex flex-col items-center justify-center gap-0 leading-none"
                      onPointerDown={() => {
                        zeroLongPress.current = false;
                        zeroPressTimer.current = setTimeout(() => {
                          zeroLongPress.current = true;
                          setToNumber(prev => !prev.startsWith('+') ? '+' + prev : prev + '+');
                        }, 500);
                      }}
                      onPointerUp={() => {
                        if (zeroPressTimer.current) clearTimeout(zeroPressTimer.current);
                        if (!zeroLongPress.current) handleNumberClick('0');
                      }}
                      onPointerLeave={() => {
                        if (zeroPressTimer.current) clearTimeout(zeroPressTimer.current);
                      }}
                      onClick={(e) => e.preventDefault()}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <span>0</span>
                      <span className="text-[10px] text-muted-foreground -mt-0.5">+</span>
                    </Button>
                  );
                }
                return (
                  <Button
                    key={digit}
                    variant="outline"
                    className="h-12 text-lg font-medium hover:bg-gray-50 active:bg-gray-200 transition-colors duration-300"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleNumberClick(digit)}
                  >
                    {digit}
                  </Button>
                );
              })
            ))}
          </div>

          {/* Call Button */}
          <Button
            className="w-full h-12 bg-black hover:bg-gray-800 text-white gap-2"
            onClick={handleCall}
            disabled={!toNumber || !fromNumber || isDialing || isInitializing}
          >
            {isDialing || isInitializing ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                {isInitializing ? t('sweep.weldcrm.globalCallPanel.connecting') : t('sweep.weldcrm.globalCallPanel.statusDialing')}
              </>
            ) : (
              <>
                {t('sweep.weldcrm.globalCallPanel.call')}
              </>
            )}
          </Button>

          {/* Recording Toggle */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={cn("h-2.5 w-2.5 rounded-full", enableRecording ? "bg-red-500" : "bg-gray-300")} />
              <Label htmlFor="recording" className="text-sm text-muted-foreground">
                {t('sweep.weldcrm.globalCallPanel.recordCall')}
              </Label>
            </div>
            <Switch
              id="recording"
              checked={enableRecording}
              onCheckedChange={setEnableRecording}
            />
          </div>

          {/* Status indicator */}
          {isInitializing && (
            <p className="text-xs text-center text-blue-600 flex items-center justify-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('sweep.weldcrm.globalCallPanel.initializingVoice')}
            </p>
          )}

          {!voipConfigured && (
            <p className="text-xs text-center text-yellow-600">
              {t('sweep.weldcrm.globalCallPanel.voipNotConfigured')}
            </p>
          )}

          {voipConfigured && !isVoipReady && !isInitializing && (
            <p className="text-xs text-center text-yellow-600">
              {t('sweep.weldcrm.globalCallPanel.voiceServiceOffline')}
            </p>
          )}

        </div>
      )}
      </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
