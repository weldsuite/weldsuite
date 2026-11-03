import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Phone,
  Plus,
  Keyboard,
  ChevronRight,
  ClipboardType,
  PhoneOff,
} from 'lucide-react';
import { useCall } from '@/contexts/call-context';
import { WeldCallGate } from '../components/weldcall-gate';
import { getTranslations } from '@/lib/i18n';
import { ActiveCallStage } from './active-call-stage';

type NewCallStrings = ReturnType<typeof getTranslations<'weldmeet'>>['weldcall']['newCall'];

/** Under the dial controls while the workspace has no phone number: the dialer can't call out yet. */
function NoNumberNotice({ tn, onConfigure }: Readonly<{ tn: NewCallStrings; onConfigure: () => void }>) {
  return (
    <div
      data-testid="weldcall-no-number"
      className="mt-6 mx-6 max-w-md w-[calc(100%-3rem)] rounded-lg border border-border bg-background p-5 text-center"
    >
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <PhoneOff className="h-5 w-5 text-muted-foreground" />
      </div>
      <h2 className="text-base font-semibold">{tn.noNumberTitle}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{tn.noNumberDescription}</p>
      <Button className="mt-4 gap-2 rounded-lg" onClick={onConfigure}>
        <Phone className="h-4 w-4" />
        {tn.configureNumber}
      </Button>
    </div>
  );
}

function NewCallContent() {
  const navigate = useNavigate();
  const {
    setIsDialerOpen,
    setInitialDialerNumber,
    phoneNumbers,
    callState,
    callStreams,
    endCall,
    toggleMute,
    toggleHold,
    sendDigits,
  } = useCall();
  const [phoneNumber, setPhoneNumber] = useState('');
  const t = getTranslations('weldmeet');
  const tn = t.weldcall.newCall;

  const handleNewCall = () => {
    setInitialDialerNumber('');
    setIsDialerOpen(true);
  };

  const handleCallNumber = () => {
    if (!phoneNumber.trim()) return;
    setInitialDialerNumber(phoneNumber.trim());
    setIsDialerOpen(true);
  };

  const hasNumber = phoneNumbers.length > 0;
  // A live call takes over the page (the floating panel steps aside here)
  if (callState) {
    return (
      <div className="flex-1 min-h-0">
        <ActiveCallStage
          callState={callState}
          callStreams={callStreams}
          onToggleMute={toggleMute}
          onToggleHold={toggleHold}
          onEndCall={endCall}
          onSendDigit={sendDigits}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div
        data-testid="weldcall-landing"
        className="flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] -mt-[60px]"
      >
        {/* Hero Section */}
        <div className="text-center max-w-2xl mx-auto px-6">
          <h1
            className="leading-tight font-sans text-[32px] md:text-[48px] text-[#171717] dark:text-foreground"
            style={{ fontWeight: 575, letterSpacing: '-0.02em' }}
          >
            {tn.heroTitle}
          </h1>
          <p
            className="leading-tight font-sans -mt-1 md:-mt-1.5 text-[32px] md:text-[48px] text-[#888888] dark:text-muted-foreground"
            style={{ fontWeight: 450, letterSpacing: '-0.02em' }}
          >
            {tn.heroSubtitle}
          </p>
          <p
            className="mt-3 md:mt-4 text-sm md:text-base text-[#666666] dark:text-muted-foreground"
            style={{
              fontWeight: 400,
              fontFamily:
                'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            }}
          >
            {tn.heroDescription}
          </p>
        </div>

        {/* Action Row */}
        <div className="flex items-center gap-3 mt-8 px-6">
          <Button size="lg" className="gap-2 rounded-lg" onClick={handleNewCall}>
            <Plus className="h-5 w-5" />
            {tn.newCall}
          </Button>

          <div className="relative group/input">
            <Keyboard className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={tn.enterPhoneNumberPlaceholder}
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCallNumber()}
              className="pl-10 pr-10 w-64 h-10 rounded-lg"
            />
            <Button
              size="icon"
              className={`absolute right-[5px] top-1/2 -translate-y-1/2 h-7 w-7 rounded-md transition-opacity duration-150 ${phoneNumber.trim() ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
              onClick={handleCallNumber}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={`absolute right-[5px] top-1/2 -translate-y-1/2 h-7 w-7 rounded-md transition-opacity duration-150 ${phoneNumber.trim() ? 'opacity-0 pointer-events-none' : 'opacity-0 group-hover/input:opacity-100'}`}
              onClick={async () => {
                const text = await navigator.clipboard.readText();
                if (text) setPhoneNumber(text);
              }}
            >
              <ClipboardType className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {!hasNumber && (
          <NoNumberNotice
            tn={tn}
            onConfigure={() => navigate({ to: '/settings/apps/phone-numbers' })}
          />
        )}
      </div>
    </div>
  );
}

export default function NewCallPage() {
  return (
    <WeldCallGate>
      <NewCallContent />
    </WeldCallGate>
  );
}
