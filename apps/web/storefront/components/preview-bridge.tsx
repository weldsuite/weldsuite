/**
 * The shop's side of the preview bridge (lib/preview.ts). Messages are only
 * taken from the parent window, from an origin in STOREFRONT_EDITOR_ORIGINS;
 * messages go out to that origin only (before the editor has spoken, to each
 * allowed origin, which the browser delivers to the one that matches).
 */

import { useRouter, useRouterState } from '@tanstack/react-router'
import type { ListName } from '@weldsuite/storefront-theme'
import { useCallback, useEffect, useRef } from 'react'
import { BRIDGE_SOURCE, isEditorOrigin, normalOrigin, parseEditorMessage, type ShopMessage } from '@/lib/preview'

const HIGHLIGHT = 'data-section-highlight'

function highlight(sectionId: string | null): void {
  for (const element of Array.from(document.querySelectorAll(`[${HIGHLIGHT}]`))) element.removeAttribute(HIGHLIGHT)
  if (!sectionId) return
  const matches = Array.from(document.querySelectorAll<HTMLElement>(`[data-section-id="${sectionId}"]`))
  for (const element of matches) element.setAttribute(HIGHLIGHT, '')
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  matches[0]?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
}

export function PreviewBridge({ origins }: Readonly<{ origins: string[] }>) {
  const router = useRouter()
  const href = useRouterState({ select: (state) => state.location.href })
  const editor = useRef<string | null>(null)

  const post = useCallback(
    (message: ShopMessage) => {
      if (window.parent === window) return
      const payload = { source: BRIDGE_SOURCE, ...message }
      const targets = editor.current ? [editor.current] : origins.map(normalOrigin).filter((origin): origin is string => origin !== null)
      for (const target of targets) window.parent.postMessage(payload, target)
    },
    [origins],
  )

  useEffect(() => {
    post({ type: 'ready', path: href })
  }, [href, post])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || !isEditorOrigin(event.origin, origins)) return
      const message = parseEditorMessage(event.data)
      if (!message) return
      editor.current = normalOrigin(event.origin)
      if (message.type === 'refresh') void router.invalidate()
      else if (message.type === 'highlight') highlight(message.sectionId)
      else void router.navigate({ href: message.path })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [origins, router])

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-section-id]') : null
      const sectionId = target?.dataset.sectionId
      const list = target?.dataset.sectionList as ListName | undefined
      if (sectionId && list) post({ type: 'select', sectionId, list })
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [post])

  return null
}
