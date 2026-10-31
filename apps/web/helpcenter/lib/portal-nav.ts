import { useCallback } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'

const FALLBACK = '/requests'

/**
 * Where to go after signing in: only a same-site relative path, never back to
 * /sign-in itself. `//host`, `/\host` and absolute URLs fall back to /requests.
 */
export function safeNext(next: string | undefined | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return FALLBACK
  // Resolve it the way a browser would (which drops tabs and newlines, so
  // "/\t/evil.com" becomes "//evil.com"): it must stay on this origin.
  const base = 'https://help-center.invalid'
  let url: URL
  try {
    url = new URL(next, base)
  } catch {
    return FALLBACK
  }
  if (url.origin !== base) return FALLBACK
  if (url.pathname === '/sign-in' || url.pathname.startsWith('/sign-in/')) return FALLBACK
  return `${url.pathname}${url.search}${url.hash}`
}

/** Sends the reader to /sign-in, coming back to the current page afterwards. */
export function useSignInRedirect(): () => void {
  const navigate = useNavigate()
  const href = useRouterState({ select: (s) => s.location.href })
  return useCallback(() => {
    void navigate({ to: '/sign-in', search: { next: href } })
  }, [navigate, href])
}
