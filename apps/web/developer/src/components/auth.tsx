import { useEffect, type ReactNode } from 'react';
import {
  OrganizationSwitcher,
  SignIn,
  SignUp,
  useAuth,
  useClerk,
  useUser,
} from '@clerk/clerk-react';
import { BookOpen, Boxes, ExternalLink, LogOut } from 'lucide-react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useDeveloperI18n } from '@/lib/i18n';
import { getPlatformUrl } from '@/lib/public-env';
import { cn } from '@/lib/utils';
import { DeveloperPermissionProvider } from '@/hooks/use-permissions';

const clerkAppearance = {
  variables: {
    colorPrimary: '#1e3a5f',
  },
} as const;

export function SignInPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center justify-center px-4">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        forceRedirectUrl="/"
        appearance={clerkAppearance}
      />
    </div>
  );
}

export function SignUpPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center justify-center px-4">
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        forceRedirectUrl="/"
        appearance={clerkAppearance}
      />
    </div>
  );
}

export function ProtectedRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();
  const { t } = useDeveloperI18n();

  if (!isLoaded) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-muted-foreground">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-primary" />
        <span className="text-sm">{t.shell.loading}</span>
      </div>
    );
  }

  if (!isSignedIn) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  return (
    <DeveloperPermissionProvider>
      <Outlet />
    </DeveloperPermissionProvider>
  );
}

function RequireWorkspace({ children }: Readonly<{ children: ReactNode }>) {
  const { isLoaded, orgId } = useAuth();
  const { t } = useDeveloperI18n();

  if (!isLoaded) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t.shell.loading}
      </div>
    );
  }

  if (!orgId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h2 className="text-lg font-semibold text-foreground">{t.shell.selectWorkspace}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{t.shell.selectWorkspaceHint}</p>
        <OrganizationSwitcher
          hidePersonal
          afterSelectOrganizationUrl="/apps"
          appearance={clerkAppearance}
        />
      </div>
    );
  }

  return <>{children}</>;
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
    isActive
      ? 'bg-background font-medium text-foreground shadow-sm'
      : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
  );

function SidebarProfile() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { t } = useDeveloperI18n();
  const name = user?.fullName || user?.firstName || 'Account';
  const email = user?.primaryEmailAddress?.emailAddress ?? '';
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?';

  return (
    <div className="mt-auto space-y-2 border-t border-border/40 pt-3">
      <OrganizationSwitcher
        hidePersonal
        afterSelectOrganizationUrl="/apps"
        appearance={{
          ...clerkAppearance,
          elements: {
            rootBox: 'w-full',
            organizationSwitcherTrigger: 'w-full justify-start px-2 py-1.5',
          },
        }}
      />
      <div className="flex items-center gap-0.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
          {user?.imageUrl ? (
            <img src={user.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              {initials}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
            {email ? (
              <span className="block truncate text-xs text-muted-foreground">{email}</span>
            ) : null}
          </span>
        </div>
        <button
          type="button"
          onClick={() => signOut({ redirectUrl: '/sign-in' })}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
          aria-label={t.shell.signOut}
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function AppShell() {
  const { t } = useDeveloperI18n();
  const platformUrl = getPlatformUrl();

  return (
    <div className="h-screen bg-[var(--shell-chrome)] p-2">
      <div className="flex h-full gap-0 overflow-hidden">
        <aside className="flex w-[220px] shrink-0 flex-col px-2 py-3">
          <div className="mb-4 px-2.5">
            <Link to="/apps" className="text-base font-semibold tracking-tight text-foreground">
              {t.brand}
            </Link>
          </div>

          <nav className="flex flex-1 flex-col gap-0.5">
            <NavLink to="/apps" className={navLinkClass} end={false}>
              <Boxes className="h-4 w-4" />
              {t.nav.apps}
            </NavLink>
            <NavLink to="/getting-started" className={navLinkClass}>
              <BookOpen className="h-4 w-4" />
              {t.nav.gettingStarted}
            </NavLink>
            <a
              href={platformUrl}
              target="_blank"
              rel="noreferrer"
              className={navLinkClass({ isActive: false })}
            >
              <ExternalLink className="h-4 w-4" />
              {t.nav.openPlatform}
            </a>
          </nav>

          <SidebarProfile />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
          <RequireWorkspace>
            <Outlet />
          </RequireWorkspace>
        </main>
      </div>
    </div>
  );
}

/** Keeps SignedIn wrappers available if needed later — unused for now. */
export function useAuthReady() {
  const { isLoaded } = useAuth();
  useEffect(() => {
    // reserved
  }, [isLoaded]);
}
