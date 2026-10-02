'use client';

import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PhoneOff, VideoOff } from 'lucide-react';

const HOME_URL = 'https://www.weldsuite.org/';

function BrandLogo() {
  return (
    <div className="absolute top-6 left-6 z-10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/weldmeet-logo-light.svg" alt="WeldMeet" className="h-5 w-auto block dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/weldmeet-logo-dark.svg" alt="WeldMeet" className="h-5 w-auto hidden dark:block" />
    </div>
  );
}

interface ErrorScreenProps {
  message: string;
  joinCode: string;
  /** Heading override; defaults to "Unable to join". */
  title?: string;
  /** Replaces the default hint under the message. Pass an empty string to hide it. */
  hint?: string;
}

export function ErrorScreen({ message, joinCode, title, hint }: Readonly<ErrorScreenProps>) {
  const platformUrl = process.env.NEXT_PUBLIC_PLATFORM_URL || 'https://app.weldsuite.org';
  const signInHref = `${platformUrl}/weldmeet/join/${joinCode}`;

  return (
    <div className="relative flex items-center justify-center min-h-screen bg-background">
      <BrandLogo />
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6 text-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
            <VideoOff className="h-6 w-6 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold mb-2">{title ?? 'Unable to join'}</h2>
          <p className="text-sm text-muted-foreground">{message}</p>
          {hint !== '' && (
            <p className="text-sm text-muted-foreground mt-4">
              {hint ?? 'Ask the host for a new link, or sign in if you are a member of this workspace.'}
            </p>
          )}
          <div className="mt-4 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-center gap-3">
            <Button asChild variant="outline" className="rounded-[var(--radius)]">
              <a href={signInHref}>Sign in</a>
            </Button>
            <Button asChild className="rounded-[var(--radius)]">
              <a href={HOME_URL}>Go to weldsuite.org</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export type EndedVariant = 'left' | 'hostEnded' | 'removed';

const ENDED_COPY: Record<EndedVariant, { heading: string; subtext: string | null }> = {
  left: { heading: 'You left the meeting', subtext: null },
  hostEnded: {
    heading: 'The host ended the meeting',
    subtext: 'This meeting has ended for everyone.',
  },
  removed: {
    heading: 'You were removed from the meeting',
    subtext: 'The host removed you from this call.',
  },
};

interface EndedScreenProps {
  variant?: EndedVariant;
  onRejoin: () => void;
  onReturnHome: () => void;
}

export function EndedScreen({ variant = 'left', onRejoin, onReturnHome }: Readonly<EndedScreenProps>) {
  const { heading, subtext } = ENDED_COPY[variant];
  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-background px-6">
      <BrandLogo />
      <h1
        className={`text-3xl sm:text-4xl font-medium tracking-tight text-foreground text-center ${
          subtext ? 'mb-3' : 'mb-8'
        }`}
      >
        {heading}
      </h1>
      {subtext && <p className="text-sm sm:text-base text-muted-foreground text-center mb-8">{subtext}</p>}
      <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 w-full max-w-xs sm:max-w-none sm:w-auto">
        {variant !== 'removed' && (
          <Button variant="outline" className="rounded-[var(--radius)] w-full sm:w-auto" onClick={onRejoin}>
            Rejoin
          </Button>
        )}
        <Button className="rounded-[var(--radius)] w-full sm:w-auto" onClick={onReturnHome}>
          Return to home screen
        </Button>
      </div>
    </div>
  );
}

export function RejectedScreen() {
  return (
    <div className="relative flex items-center justify-center min-h-screen bg-background">
      <BrandLogo />
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6 text-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
            <PhoneOff className="h-6 w-6 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold mb-2">Entry denied</h2>
          <p className="text-sm text-muted-foreground">The host did not admit you to this meeting.</p>
        </CardContent>
      </Card>
    </div>
  );
}
