import { Suspense, useState } from 'react'
import { Link, useRouter, useRouterState } from '@tanstack/react-router'
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import type { PortalState } from '@/lib/api-client'
import { signOut } from '@/lib/portal'
import { fill, usePortalStrings } from '@/lib/portal-i18n'

function UserIcon(props: Readonly<React.ComponentPropsWithoutRef<'svg'>>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <circle cx="10" cy="7" r="3.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.75 16.5c.9-2.6 3.3-4.25 6.25-4.25s5.35 1.65 6.25 4.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

const itemClass =
  'block w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-700 data-[focus]:bg-zinc-100 data-[focus]:text-zinc-900 dark:text-zinc-300 dark:data-[focus]:bg-zinc-800 dark:data-[focus]:text-white'

function AccountNavInner({ portal }: Readonly<{ portal: PortalState }>) {
  const t = usePortalStrings()
  const router = useRouter()
  const href = useRouterState({ select: (s) => s.location.href })
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [signingOut, setSigningOut] = useState(false)

  const submitLink = (
    <Link
      to="/requests/new"
      className="hidden items-center rounded-lg bg-[var(--hc-accent)] px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:brightness-110 md:inline-flex"
    >
      {t.submitRequest}
    </Link>
  )

  if (!portal.email) {
    // Coming back to this page after signing in; not to /sign-in itself.
    const next = pathname === '/sign-in' ? undefined : href
    return (
      <>
        {submitLink}
        <Link
          to="/sign-in"
          search={next ? { next } : {}}
          aria-label={t.signIn}
          className="flex items-center rounded-lg px-2 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 sm:px-2.5 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
        >
          {/* Icon on phones, where the header is short of room. */}
          <UserIcon className="h-[18px] w-[18px] sm:hidden" />
          <span className="hidden sm:inline">{t.signIn}</span>
        </Link>
      </>
    )
  }

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      // Drop whatever was loaded for this reader before going home.
      router.clearCache()
      await router.navigate({ to: '/' })
      await router.invalidate()
      setSigningOut(false)
    }
  }

  return (
    <>
      {submitLink}
      <Menu as="div" className="relative">
        <MenuButton
          className="flex max-w-[14rem] items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
          aria-label={t.account}
        >
          <UserIcon className="h-[18px] w-[18px] shrink-0" />
          <span className="hidden truncate lg:inline">{portal.email}</span>
        </MenuButton>
        <MenuItems
          anchor="bottom end"
          className="z-50 mt-2 w-60 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg [--anchor-gap:0.5rem] focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
        >
          <p className="truncate px-3 pt-1.5 pb-2 text-xs text-zinc-500 dark:text-zinc-400">
            {fill(t.signedInAs, { email: portal.email })}
          </p>
          <MenuItem>
            <Link to="/requests" className={itemClass}>
              {t.myRequests}
            </Link>
          </MenuItem>
          <MenuItem>
            <Link to="/requests/new" className={itemClass}>
              {t.submitRequest}
            </Link>
          </MenuItem>
          <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
          <MenuItem>
            <button type="button" disabled={signingOut} onClick={() => void handleSignOut()} className={itemClass}>
              {t.signOut}
            </button>
          </MenuItem>
        </MenuItems>
      </Menu>
    </>
  )
}

/** Header links for sign-in and requests; renders nothing when sign-in is off here. */
export function AccountNav({ portal }: Readonly<{ portal: PortalState }>) {
  if (!portal.enabled) return null
  return (
    <Suspense fallback={null}>
      <AccountNavInner portal={portal} />
    </Suspense>
  )
}
