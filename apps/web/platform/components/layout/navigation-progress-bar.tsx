import { useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';

/**
 * Slim indeterminate progress bar along the top edge of the viewport, shown
 * while the router is resolving a navigation (loading a route chunk and/or
 * running loaders).
 *
 * Replaces the old NavigationLoadingWrapper, which unmounted the entire page
 * and swapped in a centered spinner — producing a spinner→skeleton→content
 * triple flash on every cross-module navigation. This bar overlays instead of
 * replacing: the current page stays visible and interactive while the next
 * one loads.
 *
 * Timing: nothing renders for the first SHOW_DELAY_MS so fast navigations
 * (preloaded chunk + warm cache — the common case) never flash the bar. Slow
 * ones get a bar that advances quickly then crawls (nav-progress-advance in
 * globals.css); when the router settles it snaps to full width and fades out.
 */
const SHOW_DELAY_MS = 120;
const DONE_FADE_MS = 250;

type Phase = 'hidden' | 'loading' | 'done';

export function NavigationProgressBar() {
  const t = useTranslations();
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });
  const [phase, setPhase] = useState<Phase>('hidden');

  useEffect(() => {
    if (isPending) {
      const timer = setTimeout(() => setPhase('loading'), SHOW_DELAY_MS);
      return () => clearTimeout(timer);
    }
    // Router settled. If the bar was showing, complete it; if the navigation
    // finished inside the show-delay window, it was never visible — stay hidden.
    setPhase((current) => (current === 'loading' ? 'done' : 'hidden'));
  }, [isPending]);

  useEffect(() => {
    if (phase !== 'done') return;
    const timer = setTimeout(() => setPhase('hidden'), DONE_FADE_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === 'hidden') return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5"
      role="progressbar"
      aria-label={t('sweep.shared.loadingPage')}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          'h-full rounded-r-full bg-primary',
          phase === 'loading' &&
            'animate-[nav-progress-advance_5s_cubic-bezier(0.2,0.8,0.4,1)_forwards]',
          phase === 'done' && 'w-full opacity-0 transition-opacity duration-200',
        )}
      />
    </div>
  );
}
