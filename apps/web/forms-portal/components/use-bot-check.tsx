import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { BotCheckProvider } from '@weldsuite/app-api-client/schemas/weldforms'
import { createAltchaAdapter, createTurnstileAdapter, noBotCheck, type BotAdapter } from '@/lib/client/bot-check'

export interface BotCheck {
  /** A fresh token for one request (undefined when the form has no bot check). Rejects when the check cannot run. */
  take: () => Promise<string | undefined>
  /** The widget's mount point; render it once, anywhere on the page. */
  node: ReactNode
}

/**
 * The form's bot check. Turnstile needs a DOM node (`interaction-only`: it
 * stays invisible unless Cloudflare asks the visitor for something), ALTCHA
 * works in the background. `enabled` is false for flows that skip the check
 * (a personal invitation link).
 */
export function useBotCheck(provider: BotCheckProvider, siteKey: string | null, enabled: boolean): BotCheck {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const adapter = useRef<BotAdapter>(noBotCheck)
  const waiting = useRef<Array<() => void>>([])

  const active = enabled && provider !== 'none'
  useEffect(() => {
    if (!active) {
      adapter.current = noBotCheck
      return
    }
    let created: BotAdapter | null = null
    if (provider === 'altcha') created = createAltchaAdapter()
    else if (provider === 'turnstile' && siteKey && container) created = createTurnstileAdapter(container, siteKey)
    if (!created) return
    adapter.current = created
    for (const resume of waiting.current.splice(0)) resume()
    return () => {
      created?.destroy()
      adapter.current = noBotCheck
    }
  }, [active, provider, siteKey, container])

  const take = useCallback(async (): Promise<string | undefined> => {
    if (!active) return undefined
    // The adapter is made after the first paint; a call that comes sooner waits for it.
    if (adapter.current === noBotCheck) {
      await new Promise<void>((resolve) => {
        waiting.current.push(resolve)
        setTimeout(resolve, 5000)
      })
      if (adapter.current === noBotCheck) throw new Error('The bot check is not available')
    }
    return adapter.current.take()
  }, [active])

  const node: ReactNode =
    active && provider === 'turnstile' ? <div ref={setContainer} className="fixed bottom-16 left-1/2 z-50 -translate-x-1/2" /> : null
  return { take, node }
}
