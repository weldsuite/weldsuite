/**
 * WeldPanel analytics, only when the merchant set a project key. With the
 * consent banner on, nothing is loaded until the shopper allows it; their
 * choice is kept in a first-party cookie (`wsf_consent`) and can be changed
 * from the link under the footer. With the banner off, the script runs
 * cookieless (WeldPanel stores nothing without a consent grant).
 */

import { useShop } from '@weldsuite/storefront-theme'
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react'
import { COOKIE, consentCookie, serializeCookie } from '@/lib/cookies'
import type { ShopPayload } from '@/lib/payload'

type Choice = 'granted' | 'denied' | null

const ConsentContext = createContext<{ choice: Choice; choose: (choice: 'granted' | 'denied') => void; reopen: () => void; open: boolean }>({
  choice: null,
  choose: () => undefined,
  reopen: () => undefined,
  open: false,
})

export function ConsentProvider({ initial, children }: Readonly<{ initial: Choice; children: ReactNode }>) {
  const [choice, setChoice] = useState<Choice>(initial)
  const [open, setOpen] = useState(initial === null)
  const choose = (value: 'granted' | 'denied') => {
    document.cookie = serializeCookie(COOKIE.consent, value, consentCookie(window.location.protocol === 'https:'))
    setChoice(value)
    setOpen(false)
  }
  return <ConsentContext.Provider value={{ choice, choose, reopen: () => setOpen(true), open }}>{children}</ConsentContext.Provider>
}

/** The question, at the bottom of the page; never blocking it. */
export function ConsentBanner() {
  const { shop } = useShop()
  const { open, choose, reopen } = useContext(ConsentContext)
  const titleId = useId()
  const s = shop.strings.consent
  if (!open) {
    return (
      <div className="shop-container pb-6 text-sm">
        <button type="button" onClick={reopen} className="underline underline-offset-4">
          {s.title}
        </button>
      </div>
    )
  }
  const decide = (value: 'granted' | 'denied') => {
    choose(value)
    // The banner goes away: keep keyboard users in the page, not on the body.
    document.getElementById('main')?.focus()
  }
  return (
    <section
      aria-labelledby={titleId}
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-2xl flex-col gap-3 rounded-shop border border-shop-border bg-shop-bg p-5 text-shop-fg shadow-xl"
    >
      <h2 id={titleId} className="text-lg font-semibold">
        {s.title}
      </h2>
      <p>
        {s.text}{' '}
        {shop.legalPaths.privacy ? (
          <a href={shop.legalPaths.privacy} className="underline underline-offset-4">
            {s.privacy}
          </a>
        ) : null}
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="shop-btn shop-btn-primary" onClick={() => decide('granted')}>
          {s.accept}
        </button>
        <button type="button" className="shop-btn shop-btn-primary" onClick={() => decide('denied')}>
          {s.decline}
        </button>
      </div>
    </section>
  )
}

interface PanelStub {
  q?: unknown[]
  consent?: { grant: () => void; revoke: () => void }
  optIn?: () => void
  optOut?: () => void
}

declare global {
  interface Window {
    weldpanel?: PanelStub
  }
}

/** WeldPanel's queueing stub (as its install snippet does): calls wait for the script. */
function panel(): PanelStub {
  const existing = window.weldpanel
  if (existing && (existing.consent || !existing.q)) return existing
  const stub: PanelStub = existing ?? { q: [] }
  const queue = (name: string) => (...args: unknown[]) => stub.q?.push([name, args])
  stub.optIn = queue('optIn')
  stub.optOut = queue('optOut')
  stub.consent = { grant: queue('consent.grant'), revoke: queue('consent.revoke') }
  window.weldpanel = stub
  return stub
}

function loadScript(collectorUrl: string, projectKey: string): void {
  if (document.querySelector('script[data-weldpanel]')) return
  const script = document.createElement('script')
  script.async = true
  script.src = `${collectorUrl}/s.js`
  script.dataset.project = projectKey
  script.dataset.weldpanel = ''
  document.head.appendChild(script)
}

export function Analytics({ payload }: Readonly<{ payload: ShopPayload }>) {
  const { choice } = useContext(ConsentContext)
  const analytics = payload.analytics
  useEffect(() => {
    if (!analytics || payload.preview) return
    if (!analytics.banner) {
      loadScript(analytics.collectorUrl, analytics.projectKey)
      return
    }
    if (choice === 'granted') {
      const weldpanel = panel()
      weldpanel.optIn?.()
      weldpanel.consent?.grant()
      loadScript(analytics.collectorUrl, analytics.projectKey)
    } else if (choice === 'denied' && window.weldpanel) {
      window.weldpanel.consent?.revoke()
      window.weldpanel.optOut?.()
    }
  }, [analytics, choice, payload.preview])
  return null
}
