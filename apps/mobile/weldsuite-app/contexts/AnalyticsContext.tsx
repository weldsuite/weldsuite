import React, { createContext, useContext, useEffect } from 'react'
import { useClerkAuth } from './ClerkAuthContext'
import { initMixpanel, track, identify, setUserProperties, reset } from '@/lib/analytics'

const MIXPANEL_TOKEN = process.env.EXPO_PUBLIC_MIXPANEL_TOKEN ?? ''

interface AnalyticsContextType {
  track: typeof track
  identify: typeof identify
  reset: typeof reset
}

const AnalyticsContext = createContext<AnalyticsContextType>({
  track,
  identify,
  reset,
})

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useClerkAuth()

  useEffect(() => {
    initMixpanel(MIXPANEL_TOKEN)
  }, [])

  useEffect(() => {
    if (!user) return

    identify(user.id)
    setUserProperties({
      $email: user.email,
      $name: user.fullName ?? '',
      ...(user.organizationId && { organization_id: user.organizationId }),
    })
  }, [user])

  return (
    <AnalyticsContext.Provider value={{ track, identify, reset }}>
      {children}
    </AnalyticsContext.Provider>
  )
}

export function useAnalytics() {
  return useContext(AnalyticsContext)
}
