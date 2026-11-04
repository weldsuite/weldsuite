import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Hash, Mic, MicOff, Pause, Phone, Play } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  CALL_CONTROLS_BAR_CLASSES,
  CallTooltip,
  DISABLED_CONTROL_CLASSES,
  IconHighlight,
  MeetingHeader,
  OFF_STATE_CLASSES,
  type HighlightTone,
  type RightPanelKind,
  useMeetingToolsController,
} from '@weldsuite/weldmeet-ui';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import {
  DIAL_PAD_DIGITS,
  formatPhoneDisplay,
  getStatusText,
  type CallContextValue,
  type CallStateValue,
} from '@/components/weldcrm/calls/call-dialing';
import { VoiceWaveform } from './voice-waveform';
import { CallSidePanel, type CallPanelKind } from './call-side-panels';

/**
 * Your microphone, for the level meter only, while the call itself doesn't
 * expose one (a simulated call, or before the call's media is up). Released as
 * soon as it isn't needed.
 */
function useMeterMicrophone(enabled: boolean): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (!enabled || !navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    let acquired: MediaStream | null = null;

    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        acquired = s;
        setStream(s);
      })
      // No microphone or no permission: your side of the meter stays flat
      .catch(() => setStream(null));

    return () => {
      cancelled = true;
      acquired?.getTracks().forEach((track) => track.stop());
      setStream(null);
    };
  }, [enabled]);

  return stream;
}

function statusClass(status: CallStateValue['status']): string {
  switch (status) {
    case 'connected':
      return 'text-foreground';
    case 'ended':
    case 'failed':
      return 'text-red-500';
    default:
      return 'text-muted-foreground';
  }
}

function StatusChip({ tone, label }: Readonly<{ tone: 'yellow' | 'neutral'; label: string }>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
        tone === 'yellow' && 'bg-yellow-50 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400',
        tone === 'neutral' && 'bg-muted text-muted-foreground',
      )}
    >
      {label}
    </span>
  );
}

const CONTROL_TONE_CLASSES: Record<HighlightTone, string> = {
  default: 'hover:bg-secondary',
  off: OFF_STATE_CLASSES,
  active: 'hover:bg-primary',
};

interface ControlButtonProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  /** `off` is red, like a muted mic in a meeting; `active` is filled, like a raised hand. */
  tone?: HighlightTone;
  /** Shown but not usable yet; keeps its tooltip, like the meeting controls. */
  unavailable?: boolean;
}

/** A WeldMeet call control button (see `CallControlsBar` in @weldsuite/weldmeet-ui). */
function ControlButton({ icon: Icon, label, onClick, tone = 'default', unavailable }: Readonly<ControlButtonProps>) {
  return (
    <div className={cn('rounded-[18px] overflow-hidden', tone !== 'off' && 'ring-1 ring-border')}>
      <CallTooltip label={label}>
        <Button
          type="button"
          variant={tone === 'active' ? 'default' : 'secondary'}
          size="icon"
          aria-label={label}
          aria-pressed={tone !== 'default'}
          aria-disabled={unavailable || undefined}
          onClick={unavailable ? undefined : onClick}
          className={cn(
            'group/icon h-12 w-12 rounded-[18px] border-0 transition-all',
            unavailable ? DISABLED_CONTROL_CLASSES : CONTROL_TONE_CLASSES[tone],
          )}
        >
          <IconHighlight tone={unavailable ? 'default' : tone} fill>
            <Icon className="!h-[20px] !w-[20px]" />
          </IconHighlight>
        </Button>
      </CallTooltip>
    </div>
  );
}

/** WeldMeet's leave button. */
function EndCallButton({ label, onClick, disabled }: Readonly<{ label: string; onClick: () => void; disabled: boolean }>) {
  return (
    <CallTooltip label={label}>
      <Button
        type="button"
        variant="destructive"
        size="icon"
        aria-label={label}
        disabled={disabled}
        className="h-12 w-[60px] md:w-[70px] rounded-[18px] transition-all [&]:hover:brightness-90"
        onClick={onClick}
      >
        <Phone className="!h-[20px] !w-[20px] rotate-[135deg] fill-current" />
      </Button>
    </CallTooltip>
  );
}

interface CallControlsProps {
  callState: CallStateValue;
  showKeypad: boolean;
  onToggleMute: () => void;
  onToggleKeypad: () => void;
  onToggleHold: () => void;
  onEndCall: () => void;
}

/** Along the bottom, like the meeting controls bar. */
function CallControls({
  callState,
  showKeypad,
  onToggleMute,
  onToggleKeypad,
  onToggleHold,
  onEndCall,
}: Readonly<CallControlsProps>) {
  const t = useTranslations();
  const { status, isMuted, isOnHold } = callState;
  const isConnected = status === 'connected';

  return (
    <div data-testid="weldcall-controls" className={CALL_CONTROLS_BAR_CLASSES}>
      <ControlButton
        icon={isMuted ? MicOff : Mic}
        label={isMuted ? t('sweep.weldcrm.globalCallPanel.unmute') : t('sweep.weldcrm.globalCallPanel.mute')}
        tone={isMuted ? 'off' : 'default'}
        unavailable={!isConnected}
        onClick={onToggleMute}
      />
      <ControlButton
        icon={Hash}
        label={t('sweep.weldcrm.globalCallPanel.keypad')}
        tone={showKeypad ? 'active' : 'default'}
        unavailable={!isConnected}
        onClick={onToggleKeypad}
      />
      <ControlButton
        icon={isOnHold ? Play : Pause}
        label={isOnHold ? t('sweep.weldcrm.globalCallPanel.resume') : t('sweep.weldcrm.globalCallPanel.hold')}
        tone={isOnHold ? 'active' : 'default'}
        unavailable={!isConnected}
        onClick={onToggleHold}
      />
      <EndCallButton
        label={t('sweep.weldcrm.globalCallPanel.endCall')}
        disabled={status === 'ended' || status === 'failed'}
        onClick={onEndCall}
      />
    </div>
  );
}

interface ActiveCallStageProps {
  callState: CallStateValue;
  callStreams: CallContextValue['callStreams'];
  onToggleMute: () => void;
  onToggleHold: () => void;
  onEndCall: () => void;
  onSendDigit: (digit: string) => void;
}

/** Takes over the WeldCall page for the length of a call. */
export function ActiveCallStage({
  callState,
  callStreams,
  onToggleMute,
  onToggleHold,
  onEndCall,
  onSendDigit,
}: Readonly<ActiveCallStageProps>) {
  const t = useTranslations();
  const weldmeet = getTranslations('weldmeet');
  const { newCall: tn, callDetail: td } = weldmeet.weldcall;
  const headerLabels = weldmeet.inCall.header;
  const [showKeypad, setShowKeypad] = useState(false);
  const [sentDigits, setSentDigits] = useState('');
  const [panel, setPanel] = useState<CallPanelKind | null>(null);

  // The header offers Details, People and Tools (no host controls); a second click closes the open one
  const togglePanel = (next: NonNullable<RightPanelKind>) => {
    if (next === 'settings') return;
    setPanel((open) => (open === next ? null : next));
  };

  const { status, isMuted, isOnHold, isRecording, contactName } = callState;
  const isConnected = status === 'connected';
  // The same subject the call's own page gives it afterwards
  const callTitle = td.outboundCallTo.replace('{phoneLabel}', contactName || formatPhoneDisplay(callState.toNumber));

  // WeldMeet's meeting tools, run for this call only: there is no meeting to share them with
  const toolsLabels = useMemo(() => {
    const labels = getTranslations('weldmeet').inCall.tools;
    return { ...labels, timer: { ...labels.timer, hostHint: getTranslations('weldmeet').weldcall.newCall.timerHint } };
  }, []);
  const tools = useMeetingToolsController({
    meeting: null,
    local: true,
    participants: [],
    isOrganizer: true,
    meetingTitle: callTitle,
    labels: toolsLabels,
    panelOpen: panel === 'tools',
    onOpenPanel: () => setPanel('tools'),
  });

  const isLive = isConnected && !isOnHold;
  const meterMic = useMeterMicrophone(isLive && !isMuted && !callStreams.local);

  // Both sides, live; muting drops yours, so the bars show what the other person hears
  const streams = useMemo(
    () =>
      [callStreams.remote, isMuted ? null : (callStreams.local ?? meterMic)].filter(
        (s): s is MediaStream => s !== null,
      ),
    [callStreams.remote, callStreams.local, meterMic, isMuted],
  );

  const sendDigit = (digit: string) => {
    onSendDigit(digit);
    setSentDigits((prev) => prev + digit);
  };

  return (
    <div data-testid="weldcall-active-call" className="relative flex h-full min-h-0 bg-background">
      <div className="flex flex-1 min-w-0 flex-col">
        {/* The meeting header: title, the recording label, Details and People. A phone call has no chat or tools. */}
        <MeetingHeader
          meetingTitle={callTitle}
          headerLabels={headerLabels}
          participantsCount={isConnected ? 2 : 1}
          statusSlot={
            isConnected &&
            isRecording && (
              <SoftBadge tone="danger">
                <span className="size-1.5 rounded-full bg-current animate-pulse" aria-hidden />
                {t('sweep.weldcrm.globalCallPanel.recording')}
              </SoftBadge>
            )
          }
          rightPanel={panel}
          showChat={false}
          onToggleRightPanel={togglePanel}
          onToggleChat={() => {}}
          showChatButton={false}
        />

        {/* Who you're calling, at the top */}
        <div data-testid="weldcall-call-header" className="flex shrink-0 flex-col items-center px-6 pt-10">
          <h1
            className="text-center font-sans text-[32px] leading-tight tabular-nums text-[#171717] dark:text-foreground"
            style={{ fontWeight: 575, letterSpacing: '-0.02em' }}
          >
            {contactName || formatPhoneDisplay(callState.toNumber)}
          </h1>
          {contactName && (
            <p className="mt-1 text-sm tabular-nums text-muted-foreground">{formatPhoneDisplay(callState.toNumber)}</p>
          )}
          <p data-testid="weldcall-call-status" className={cn('mt-1 text-base tabular-nums', statusClass(status))}>
            {getStatusText(status, callState.duration, t)}
          </p>

          <div className="mt-3 flex h-6 items-center gap-2">
            {isConnected && isOnHold && <StatusChip tone="yellow" label={t('sweep.weldcrm.globalCallPanel.onHold')} />}
            {isConnected && isMuted && <StatusChip tone="neutral" label={tn.muted} />}
          </div>
        </div>

        {/* The waves (or the keypad) in the middle of the space that's left */}
        <div
          data-testid="weldcall-call-stage"
          className="flex flex-1 min-h-0 flex-col items-center justify-center overflow-auto px-6 py-6"
        >
          {showKeypad && isConnected ? (
            <div className="flex w-full max-w-[320px] flex-col items-center">
              <p className="mb-3 h-6 font-mono text-lg tracking-widest text-foreground">{sentDigits}</p>
              <div className="grid w-full grid-cols-3 gap-2">
                {DIAL_PAD_DIGITS.map((digit) => (
                  <Button
                    key={digit}
                    type="button"
                    variant="outline"
                    className="h-12 rounded-xl text-lg font-medium"
                    onClick={() => sendDigit(digit)}
                  >
                    {digit}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <VoiceWaveform mode={isLive ? 'live' : 'flat'} streams={streams} />
          )}
        </div>

        <CallControls
          callState={callState}
          showKeypad={showKeypad}
          onToggleMute={onToggleMute}
          onToggleKeypad={() => setShowKeypad((v) => !v)}
          onToggleHold={onToggleHold}
          onEndCall={onEndCall}
        />
      </div>

      {panel && (
        <CallSidePanel
          panel={panel}
          callState={callState}
          callTitle={callTitle}
          tools={tools}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
