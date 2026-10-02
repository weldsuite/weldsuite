'use client';

import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PhoneOff, VideoOff } from 'lucide-react';

interface ErrorScreenProps {
  message: string;
  joinCode: string;
}

export function ErrorScreen({ message, joinCode }: Readonly<ErrorScreenProps>) {
  const platformUrl = process.env.NEXT_PUBLIC_PLATFORM_URL || 'https://app.weldsuite.org';
  const signInHref = `${platformUrl}/weldmeet/join/${joinCode}`;

  return (
    <div className="relative flex items-center justify-center min-h-screen bg-background">
      <div className="absolute top-6 left-6 z-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/weldmeet-logo-light.svg" alt="WeldMeet" className="h-5 w-auto block dark:hidden" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/weldmeet-logo-dark.svg" alt="WeldMeet" className="h-5 w-auto hidden dark:block" />
      </div>
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6 text-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
            <VideoOff className="h-6 w-6 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold mb-2">Unable to join</h2>
          <p className="text-sm text-muted-foreground">{message}</p>
          <p className="text-sm text-muted-foreground mt-4">
            Ask the host for a new link, or sign in if you are a member of this workspace.
          </p>
          <Button asChild variant="outline" className="mt-4 rounded-[var(--radius)]">
            <a href={signInHref}>Sign in</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

interface EndedScreenProps {
  onRejoin: () => void;
  onReturnHome: () => void;
}

export function EndedScreen({ onRejoin, onReturnHome }: Readonly<EndedScreenProps>) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background px-6">
      <h1 className="text-3xl sm:text-4xl font-medium tracking-tight text-foreground mb-8 text-center">
        You left the meeting
      </h1>
      <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 w-full max-w-xs sm:max-w-none sm:w-auto">
        <Button variant="outline" className="rounded-[var(--radius)] w-full sm:w-auto" onClick={onRejoin}>
          Rejoin
        </Button>
        <Button className="rounded-[var(--radius)] w-full sm:w-auto" onClick={onReturnHome}>
          Return to home screen
        </Button>
      </div>
    </div>
  );
}

export function RejectedScreen() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
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
