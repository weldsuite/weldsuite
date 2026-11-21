'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** A navigation link that marks the current page with aria-current (and an underline, not colour alone). */
export function NavLink({
  href,
  children,
  className = '',
  exact = false,
}: Readonly<{
  href: string;
  children: ReactNode;
  className?: string;
  /** Only the page itself, not the pages under it. */
  exact?: boolean;
}>) {
  const pathname = usePathname();
  const current = pathname === href || (!exact && href !== '/' && pathname.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`underline-offset-8 hover:underline aria-[current=page]:font-semibold aria-[current=page]:underline aria-[current=page]:decoration-2 ${className}`}
    >
      {children}
    </Link>
  );
}
