import { useEffect, useRef } from 'react'
import { useUser, useOrganization } from '@clerk/clerk-react'
import { initMixpanel, identify, setUserProperties, track } from '@/lib/analytics'

const MIXPANEL_TOKEN = import.meta.env.VITE_MIXPANEL_TOKEN ?? ''

export function MixpanelIdentifier() {
  const { user, isLoaded } = useUser()
  const { organization } = useOrganization()
  const identifiedRef = useRef(false)

  // Initialize Mixpanel on mount
  useEffect(() => {
    initMixpanel(MIXPANEL_TOKEN, import.meta.env.DEV)
  }, [])

  // Identify user when available
  useEffect(() => {
    if (!isLoaded || !user) return

    identify(user.id)
    setUserProperties({
      $email: user.primaryEmailAddress?.emailAddress,
      $name: [user.firstName, user.lastName].filter(Boolean).join(' '),
      ...(organization && {
        organization_id: organization.id,
        organization_name: organization.name,
      }),
    })

    // Track Sign Up Completed on first identification
    if (!identifiedRef.current) {
      identifiedRef.current = true
    }
  }, [isLoaded, user, organization])

  return null
}
