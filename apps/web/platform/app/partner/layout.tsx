/**
 * Partner portal layout.
 *
 * Rendered WITHOUT the platform shell (see `isMinimalPath` in
 * `components/app-shell-client.tsx`): a reseller may belong to no workspace at
 * all, and the shell sends such a session to /onboarding. The portal therefore
 * does its own sign-in check and talks to `/api/partner/*`, which needs a Clerk
 * session but no active organization.
 */

import { useEffect, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useAuth, useClerk, useOrganizationList, useUser } from '@clerk/clerk-react';
import { ArrowLeft, Handshake, LogOut, TriangleAlert } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import {
  PartnerProvider,
  usePartnerContext,
  usePartnerMemberships,
} from '@/lib/partner/partner-context';
import { cn } from '@/lib/utils';
import { EmptyBlock, ErrorBlock, PartnerStatusBadge } from './components/kit';

interface NavItem {
  to: '/partner' | '/partner/workspaces' | '/partner/requests' | '/partner/packages' | '/partner/statements' | '/partner/team' | '/partner/settings';
  label: string;
  exact?: boolean;
  visible: boolean;
}

function PartnerHeader() {
  const { t } = useI18n();
  const { memberships, membership, select, can } = usePartnerContext();
  const { signOut } = useClerk();
  const { userMemberships } = useOrganizationList({ userMemberships: true });
  const hasWorkspace = (userMemberships?.count ?? 0) > 0;
  const tn = t.partner.nav;

  const items: NavItem[] = [
    { to: '/partner', label: tn.overview, exact: true, visible: true },
    { to: '/partner/workspaces', label: tn.workspaces, visible: true },
    { to: '/partner/requests', label: tn.requests, visible: true },
    { to: '/partner/packages', label: tn.packages, visible: true },
    { to: '/partner/statements', label: tn.statements, visible: can('partner:billing:read') },
    { to: '/partner/team', label: tn.team, visible: true },
    { to: '/partner/settings', label: tn.settings, visible: true },
  ];

  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Handshake className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate text-sm font-semibold">{t.partner.brand}</span>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          {memberships.length > 1 ? (
            <Select value={membership.partnerId} onValueChange={select}>
              <SelectTrigger className="h-8 w-[200px]" aria-label={tn.switchPartner}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {memberships.map((m) => (
                  <SelectItem key={m.partnerId} value={m.partnerId}>
                    {m.partnerName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="truncate text-sm text-muted-foreground">{membership.partnerName}</span>
          )}
          {membership.status !== 'active' && <PartnerStatusBadge status={membership.status} />}
        </div>

        <div className="ml-auto flex items-center gap-1">
          {hasWorkspace && (
            <Button asChild variant="ghost" size="sm">
              <Link to="/">
                <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
                {tn.backToWeldSuite}
              </Link>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => signOut({ redirectUrl: '/auth/login' })}>
            <LogOut className="mr-1.5 h-4 w-4" aria-hidden />
            {tn.signOut}
          </Button>
        </div>
      </div>

      <nav aria-label={t.partner.title} className="mx-auto max-w-6xl overflow-x-auto px-2 md:px-4">
        <ul className="flex min-w-max items-center gap-1">
          {items
            .filter((item) => item.visible)
            .map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: item.exact ?? false }}
                  className={cn(
                    'inline-block border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors',
                    'hover:text-foreground',
                  )}
                  activeProps={{ className: 'border-foreground text-foreground font-medium' }}
                >
                  {item.label}
                </Link>
              </li>
            ))}
        </ul>
      </nav>
    </header>
  );
}

/** Past-due / suspended notice for the partner itself. */
function PartnerStatusBanner() {
  const { t } = useI18n();
  const { membership, can } = usePartnerContext();
  if (membership.status === 'active') return null;
  const suspended = membership.status === 'suspended';
  const tb = t.partner.banner;

  return (
    <div
      role="alert"
      className={cn(
        'border-b px-4 py-3 text-sm md:px-6',
        suspended
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      )}
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1">
        <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          <span className="font-medium">{suspended ? tb.suspendedTitle : tb.pastDueTitle}. </span>
          {suspended ? tb.suspendedBody : tb.pastDueBody}
        </p>
        {can('partner:billing:read') && (
          <Link to="/partner/statements" className="shrink-0 font-medium underline underline-offset-2">
            {tb.viewStatements}
          </Link>
        )}
      </div>
    </div>
  );
}

export default function PartnerLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { t, format } = useI18n();
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { memberships, isLoading, isError, refetch } = usePartnerMemberships();

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      window.location.href = `/auth/login?callbackUrl=${encodeURIComponent(window.location.pathname)}`;
    }
  }, [isLoaded, isSignedIn]);

  if (!isLoaded || !isSignedIn || isLoading) return <PageLoader label={t.partner.common.loading} />;

  if (isError) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorBlock onRetry={() => void refetch()} />
      </div>
    );
  }

  if (memberships.length === 0) {
    const email = user?.primaryEmailAddress?.emailAddress ?? '';
    return (
      <div className="mx-auto max-w-xl p-6 pt-24">
        <EmptyBlock
          icon={Handshake}
          title={t.partner.notPartner.title}
          description={format(t.partner.notPartner.description, { email })}
          action={
            <Button asChild variant="outline">
              <Link to="/">{t.partner.notPartner.action}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <PartnerProvider memberships={memberships}>
      <div className="min-h-screen bg-background text-foreground">
        <PartnerHeader />
        <PartnerStatusBanner />
        <main className="mx-auto max-w-6xl px-4 py-6 md:px-6">{children}</main>
      </div>
    </PartnerProvider>
  );
}
