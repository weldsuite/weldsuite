import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Inbox, PenSquare, CreditCard, User, LogOut } from 'lucide-react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { setPersonalApiTokenGetter } from '@/lib/api';
import { cn } from '@/lib/utils';

export function TokenBridge({ children }: { children: ReactNode }) {
  const { getToken, isSignedIn } = useAuth();

  if (isSignedIn) {
    setPersonalApiTokenGetter(async () => getToken());
  } else {
    setPersonalApiTokenGetter(null);
  }

  return <>{children}</>;
}

export function ProtectedRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();

  if (!isLoaded) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-muted-foreground">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-primary" />
        <span className="text-sm">Loading…</span>
      </div>
    );
  }

  if (!isSignedIn) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
    isActive
      ? 'bg-background text-foreground font-medium shadow-sm'
      : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
  );

export function AppShell() {
  const { signOut, has } = useAuth();
  const isPro = Boolean(has?.({ plan: 'weldmail_pro' }));

  return (
    <div className="h-screen bg-[var(--shell-chrome)] p-2">
      <div className="flex h-full gap-0 overflow-hidden">
        <aside className="flex w-[200px] shrink-0 flex-col px-2 py-3">
          <div className="mb-4 flex items-center gap-2 px-2.5">
            <Link to="/" className="text-base font-semibold tracking-tight text-foreground">
              WeldMail
            </Link>
            {isPro ? (
              <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
                Pro
              </span>
            ) : (
              <Link
                to="/pricing"
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
              >
                Upgrade
              </Link>
            )}
          </div>

          <nav className="flex flex-1 flex-col gap-0.5">
            <NavLink to="/inbox" className={navLinkClass}>
              <Inbox className="h-4 w-4" />
              Inbox
            </NavLink>
            <NavLink to="/compose" className={navLinkClass}>
              <PenSquare className="h-4 w-4" />
              Compose
            </NavLink>
            <NavLink to="/pricing" className={navLinkClass}>
              <CreditCard className="h-4 w-4" />
              Pricing
            </NavLink>
            <NavLink to="/account" className={navLinkClass}>
              <User className="h-4 w-4" />
              Account
            </NavLink>
          </nav>

          <button
            type="button"
            onClick={() => signOut()}
            className="mt-auto flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-background/60 hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Ensures token getter stays fresh when auth changes. */
export function useSyncPersonalToken() {
  const { getToken, isSignedIn } = useAuth();

  useEffect(() => {
    if (isSignedIn) {
      setPersonalApiTokenGetter(async () => getToken());
    } else {
      setPersonalApiTokenGetter(null);
    }
  }, [getToken, isSignedIn]);
}
