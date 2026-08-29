import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { setPersonalApiTokenGetter } from '@/lib/api';

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
      <div className="center-state">
        <div className="spinner" />
        <span>Loading…</span>
      </div>
    );
  }

  if (!isSignedIn) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

export function AppShell() {
  const { signOut } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          WeldMail
        </Link>
        <nav className="nav-links">
          <NavLink to="/inbox" className={({ isActive }) => (isActive ? 'active' : undefined)}>
            Inbox
          </NavLink>
          <NavLink to="/compose" className={({ isActive }) => (isActive ? 'active' : undefined)}>
            Compose
          </NavLink>
          <button type="button" className="btn btn-ghost" onClick={() => signOut()}>
            Sign out
          </button>
        </nav>
      </header>
      <Outlet />
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
