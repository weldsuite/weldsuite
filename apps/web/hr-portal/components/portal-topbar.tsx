'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { LogOut, Menu, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';
import type { Me, PortalConfig } from '@/lib/types';
import { PortalLogo } from '@/components/portal-logo';
import { clearPortalCache } from '@/lib/query-client';
import { usePrefetchRoute } from '@/lib/hooks/use-prefetch-route';

interface NavItem {
  href: string;
  label: string;
}

export function PortalTopbar({ me, config }: Readonly<{ me: Me; config: PortalConfig }>) {
  const slug = String(useParams().workspace ?? '');
  const pathname = usePathname();
  const router = useRouter();
  const { dict, locale, setLocale } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const prefetchRoute = usePrefetchRoute(slug);

  const navItems: NavItem[] =
    me.kind === 'employee'
      ? [
          { href: `/${slug}/me`, label: dict.nav.home },
          { href: `/${slug}/me/schedule`, label: dict.nav.schedule },
          { href: `/${slug}/me/leave`, label: dict.nav.leave },
          { href: `/${slug}/me/coaching`, label: dict.nav.coaching },
          { href: `/${slug}/me/evaluations`, label: dict.nav.evaluations },
          { href: `/${slug}/me/tasks`, label: dict.nav.tasks },
          { href: `/${slug}/me/performance`, label: dict.nav.performance },
        ]
      : [
          { href: `/${slug}/client`, label: dict.nav.overview },
          { href: `/${slug}/client/milestones`, label: dict.nav.milestones },
          { href: `/${slug}/client/requests`, label: dict.nav.requests },
        ];

  async function signOut() {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    clearPortalCache(slug);
    router.push(`/${slug}/login`);
  }

  function toggleLocale() {
    setLocale((locale === 'en' ? 'nl' : 'en') as Locale);
  }

  return (
    <header className="border-b border-gray-200 bg-white sticky top-0 z-10">
      <div className="flex items-center gap-3 px-4 py-3">
        <Link href={navItems[0]?.href ?? `/${slug}`} className="flex items-center gap-2 shrink-0">
          <PortalLogo config={config} size={32} />
          <span className="font-semibold text-gray-900 hidden sm:inline">{config.displayName}</span>
        </Link>

        <nav className="hidden md:flex items-center gap-1 ml-4 overflow-x-auto">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onMouseEnter={() => prefetchRoute(item.href)}
              onFocus={() => prefetchRoute(item.href)}
              onTouchStart={() => prefetchRoute(item.href)}
              className={`rounded-md px-3 py-2 text-sm whitespace-nowrap ${
                pathname === item.href ? 'font-semibold portal-accent' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={toggleLocale}
            className="text-xs font-medium text-gray-500 border border-gray-200 rounded px-2 py-1 hover:bg-gray-50"
            aria-label={dict.userMenu.language}
          >
            {locale.toUpperCase()}
          </button>
          <div className="hidden sm:flex items-center gap-2 text-sm text-gray-500">
            <span className="truncate max-w-[10rem]">{me.displayName}</span>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm text-gray-600 hover:bg-gray-50 min-h-[40px]"
          >
            <LogOut size={16} />
            <span className="hidden sm:inline">{dict.userMenu.signOut}</span>
          </button>
          <button
            type="button"
            className="md:hidden inline-flex items-center justify-center rounded-md p-2 text-gray-600 hover:bg-gray-50 min-h-[40px] min-w-[40px]"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Menu"
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav className="md:hidden border-t border-gray-200 px-2 py-2 flex flex-col gap-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onMouseEnter={() => prefetchRoute(item.href)}
              onFocus={() => prefetchRoute(item.href)}
              onTouchStart={() => prefetchRoute(item.href)}
              onClick={() => setMenuOpen(false)}
              className={`rounded-md px-3 py-2.5 text-sm ${
                pathname === item.href ? 'font-semibold portal-accent bg-gray-50' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
