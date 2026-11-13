import React, { createContext, useContext, useEffect } from 'react';
import { peekMobileRuntime } from '@weldsuite/mobile-platform/runtime';
import { useAuthSession } from './AuthContext';
import { initMixpanel, track, identify, setUserProperties, reset } from '../lib/analytics';

const MIXPANEL_TOKEN = process.env.EXPO_PUBLIC_MIXPANEL_TOKEN ?? '';

interface AnalyticsContextType {
  track: typeof track;
  identify: typeof identify;
  reset: typeof reset;
}

// The tracking helpers are module-level, so one stable value serves every render.
const ANALYTICS_VALUE: AnalyticsContextType = { track, identify, reset };

const AnalyticsContext = createContext<AnalyticsContextType>({
  track,
  identify,
  reset,
});

export function AnalyticsProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const { user } = useAuthSession();
  // Servers that list `analytics` as unavailable (EU, self-hosted) get none.
  const enabled = !peekMobileRuntime()?.unavailableFeatures.has('analytics');

  useEffect(() => {
    if (!enabled) return;
    initMixpanel(MIXPANEL_TOKEN).catch(() => {
      // Analytics is best effort; the app works without it.
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !user) return;

    identify(user.id);
    setUserProperties({
      $email: user.email,
      $name: user.fullName ?? '',
      ...(user.organizationId && { organization_id: user.organizationId }),
    });
  }, [enabled, user]);

  return (
    <AnalyticsContext.Provider value={ANALYTICS_VALUE}>
      {children}
    </AnalyticsContext.Provider>
  );
}

export function useAnalytics() {
  return useContext(AnalyticsContext);
}
