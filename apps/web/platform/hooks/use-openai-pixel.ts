import { useEffect } from 'react';
import { loadOpenAIPixel } from '@/lib/openai-ads';

/**
 * Loads the ChatGPT Ads pixel on a registration surface. Mount it on any page
 * that can complete a signup, early enough that the SDK has arrived by the time
 * the conversion fires — the register page redirects to /onboarding right after
 * measuring, and an SDK still in flight would take the event with it.
 */
export function useOpenAIPixel(): void {
  useEffect(() => {
    loadOpenAIPixel();
  }, []);
}
