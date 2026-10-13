import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Phone,
  Plus,
  Keyboard,
  ChevronRight,
  ClipboardType,
  History,
  PhoneOff,
} from 'lucide-react';
import { useCall } from '@/contexts/call-context';
import { cn } from '@/lib/utils';
import { WeldCallGate } from '../components/weldcall-gate';
import { getTranslations } from '@/lib/i18n';

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
    isDialerOpen,
    callState,
    isMinimized,
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
  // The dialer floats over the bottom-right corner (340px + 16px gutters). While
  // it's expanded, shift the hero out from under it when there's room to.
  const isDialerShown = isDialerOpen || (!!callState && !isMinimized);

  return (
    <div className="flex-1 overflow-auto @container">
      <div
        data-testid="weldcall-landing"
        className={cn(
          'flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] -mt-[60px] transition-[padding] duration-300 ease-in-out',
          isDialerShown && '@3xl:pr-[372px]',
        )}
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="lg" className="gap-2 rounded-lg">
                <Plus className="h-5 w-5" />
                {tn.newCall}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuItem onClick={handleNewCall}>
                <Phone className="h-4 w-4 mr-0.5" />
                {tn.openDialer}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => navigate({ to: '/weldcall/history' })}
              >
                <History className="h-4 w-4 mr-0.5" />
                {tn.viewCallHistory}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

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
