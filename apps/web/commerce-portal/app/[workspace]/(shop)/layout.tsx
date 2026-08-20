'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { en } from '@weldsuite/i18n/locales/en';

const t = en.commerce.portalApp;

export default function ShopLayout({ children }: { children: React.ReactNode }) {
  const slug = String(useParams().workspace ?? '');
  const pathname = usePathname();
  const router = useRouter();
  const links = [
    { href: `/${slug}`, label: t.catalog },
    { href: `/${slug}/cart`, label: t.cart },
    { href: `/${slug}/orders`, label: t.orders },
    { href: `/${slug}/invoices`, label: t.invoices },
    { href: `/${slug}/returns`, label: t.returns },
    { href: `/${slug}/account`, label: t.account },
  ];

  async function signOut() {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    router.push(`/${slug}/login`);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b px-4 py-3 flex items-center gap-4 overflow-x-auto">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`text-sm whitespace-nowrap ${pathname === l.href ? 'font-semibold' : 'text-muted-foreground'}`}
          >
            {l.label}
          </Link>
        ))}
        <button type="button" onClick={() => void signOut()} className="ml-auto text-sm text-muted-foreground">
          {t.signOut}
        </button>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
