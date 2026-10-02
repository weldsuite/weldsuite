'use client';

import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PhoneOff, VideoOff } from 'lucide-react';

interface ErrorScreenProps {
  message: string;
}

export function ErrorScreen({ message }: Readonly<ErrorScreenProps>) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6 text-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
            <VideoOff className="h-6 w-6 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold mb-2">Unable to join</h2>
          <p className="text-sm text-muted-foreground">{message}</p>
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
    <div className="flex flex-col items-center justify-center min-h-screen bg-background px-6">
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
