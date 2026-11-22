/**
 * What a full-screen WeldChat call leaves behind when it ends (status
 * `ended`): the screen fades away over the conversation, which is already
 * back underneath, instead of showing a "call ended" screen.
 */

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export function CallFadeOut() {
  const [faded, setFaded] = useState(false);

  // One frame at full opacity, then the transition to transparent.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setFaded(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      aria-hidden="true"
      data-testid="call-fade-out"
      className={cn(
        'pointer-events-none fixed inset-0 z-50 bg-background transition-opacity duration-[950ms] ease-in-out motion-reduce:transition-none',
        faded && 'opacity-0',
      )}
    />
  );
}
