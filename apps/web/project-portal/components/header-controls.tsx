import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useTheme } from 'next-themes'
import { LogOut, Moon, Sun } from 'lucide-react'
import { Button } from '@weldsuite/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu'
import type { PortalMe } from '@weldsuite/app-api-client/schemas/project-portal'
import { LOCALES, type Locale } from '@/lib/i18n'
import { setLanguage } from '@/lib/page-data'
import { signOut } from '@/lib/portal'
import { initials } from '@/lib/format'
import { usePortal } from '@/components/portal-context'

const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', nl: 'Nederlands' }

/** Switches between light and dark; the first visit follows the browser's setting. */
export function ThemeToggle() {
  const { t } = usePortal()
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={t.common.theme}
      title={t.common.theme}
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {/* Both icons are rendered and CSS picks one, so the server's markup matches the browser's. */}
      <Sun className="dark:hidden" aria-hidden="true" />
      <Moon className="hidden dark:block" aria-hidden="true" />
    </Button>
  )
}

/** English or Dutch; remembered in a cookie, then the page's texts are fetched again. */
export function LanguageSwitch() {
  const { locale, t } = usePortal()
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function choose(next: Locale) {
    if (next === locale || pending) return
    setPending(true)
    try {
      await setLanguage({ data: { locale: next } })
      await router.invalidate()
    } finally {
      setPending(false)
    }
  }

  return (
    <div role="group" aria-label={t.common.language} className="flex items-center rounded-md border p-0.5">
      {LOCALES.map((code) => (
        <Button
          key={code}
          type="button"
          variant={code === locale ? 'secondary' : 'ghost'}
          size="xs"
          lang={code}
          aria-pressed={code === locale}
          aria-label={LANGUAGE_NAMES[code]}
          title={LANGUAGE_NAMES[code]}
          disabled={pending}
          onClick={() => void choose(code)}
        >
          {code.toUpperCase()}
        </Button>
      ))}
    </div>
  )
}

/** The signed-in contact: who they are and "Sign out". */
export function AccountMenu({ workspace, account }: Readonly<{ workspace: string; account: PortalMe }>) {
  const { t, fill } = usePortal()
  const [signingOut, setSigningOut] = useState(false)
  const name = account.contact.name

  async function leave() {
    setSigningOut(true)
    try {
      await signOut({ data: { workspace } })
    } finally {
      // A full load drops every cached page of the session.
      window.location.assign(`/${encodeURIComponent(workspace)}`)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto gap-2 px-1.5 py-1"
          aria-label={fill(t.header.accountMenu, { name })}
        >
          <span
            aria-hidden="true"
            className="inline-flex size-7 items-center justify-center rounded-full bg-amber-200 text-[11px] font-semibold text-neutral-900"
          >
            {initials(name)}
          </span>
          <span className="hidden max-w-40 truncate text-[13px] font-normal sm:inline">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-xs text-muted-foreground">{t.header.signedInAs}</span>
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{account.contact.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={signingOut} onSelect={() => void leave()}>
          <LogOut aria-hidden="true" />
          {signingOut ? t.header.signingOut : t.header.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
