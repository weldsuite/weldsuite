'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SignOutButton } from '@clerk/nextjs';
import {
  Building2,
  Headphones,
  LayoutDashboard,
  LogOut,
  Package,
  Shield,
} from 'lucide-react';
import type { AdminRole } from '@/lib/roles';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Support Inbox', href: '/support', icon: Headphones },
  { label: 'App Catalog', href: '/apps', icon: Package },
  { label: 'Workspaces', href: '/workspaces', icon: Building2 },
];

const ROLE_LABEL: Record<AdminRole, string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  viewer: 'Viewer',
};

export function Sidebar({
  name,
  email,
  role,
}: {
  name: string | null;
  email: string;
  role: AdminRole;
}) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  const label = name || email;
  const initials = (label.split(/[\s@._-]+/).filter(Boolean)[0]?.[0] ?? '?').toUpperCase();

  return (
    <div className="w-56 h-screen border-r bg-sidebar flex flex-col shrink-0">
      <div className="px-4 py-4 border-b flex items-center gap-2">
        <Shield className="h-5 w-5 text-blue-600" />
        <span className="font-semibold text-sm">WeldSuite Admin</span>
      </div>

      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
              isActive(item.href)
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="border-t p-2">
        <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg">
          <div className="h-8 w-8 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-semibold shrink-0">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{label}</div>
            <div className="text-[11px] text-muted-foreground truncate">{ROLE_LABEL[role]}</div>
          </div>
          <SignOutButton>
            <button
              title="Sign out"
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </SignOutButton>
        </div>
      </div>
    </div>
  );
}
