import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useAuth, useOrganizationList } from '@clerk/clerk-react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { setPendingOrganization } from '@/lib/pending-organization';
import { findWorkspace, parseWorkspacePath, sameOriginPath } from '@/lib/workspace-url';
import {
  WorkspaceLinkProblem,
  type WorkspaceLinkMembership as Membership,
} from '@/components/workspace/workspace-link-problem';

type Status = 'resolving' | 'not-found' | 'error';

/**
 * `/w/{ref}/…` (FE-013): open the inner path in the workspace the link names.
 *
 * Only reached with the kill switch off (`VITE_WORKSPACE_IN_URL=false`): with
 * the router rewrite on, `/w/{ref}` is stripped before routing and the shell's
 * workspace check (components/workspace-url-gate.tsx) does this job.
 *
 * Clerk keeps the active organization per tab, so activating the linked
 * workspace here does not move the user's other tabs. When it is already the
 * active one, this is a client-side redirect; otherwise the tab switches and
 * reloads, like the workspace switcher, so nothing hydrates against the
 * previous workspace.
 */
export default function WorkspaceLinkPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const { isLoaded: orgListLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true, pageSize: 50 },
  });
  const [status, setStatus] = useState<Status>('resolving');
  const startedRef = useRef(false);

  const link = useMemo(() => {
    const parsed = parseWorkspacePath(window.location.pathname);
    if (!parsed) return null;
    const target = sameOriginPath(
      parsed.rest + window.location.search + window.location.hash,
      window.location.origin,
    );
    return { ref: parsed.ref, target };
  }, []);

  const memberships = useMemo<Membership[]>(
    () =>
      (userMemberships?.data ?? []).map((m) => ({
        id: m.organization.id,
        slug: m.organization.slug,
        name: m.organization.name,
      })),
    [userMemberships?.data],
  );

  useEffect(() => {
    if (!isLoaded || startedRef.current) return;

    if (!isSignedIn) {
      startedRef.current = true;
      const here = window.location.pathname + window.location.search + window.location.hash;
      window.location.href = `/auth/login?callbackUrl=${encodeURIComponent(here)}`;
      return;
    }

    if (!link) {
      startedRef.current = true;
      setStatus('not-found');
      return;
    }

    if (!orgListLoaded || !setActive || !userMemberships || userMemberships.isLoading) return;

    const workspace = findWorkspace(link.ref, memberships);
    if (!workspace) {
      // Memberships are paged; only give up once every page is in.
      if (userMemberships.hasNextPage) {
        if (!userMemberships.isFetching) userMemberships.fetchNext();
        return;
      }
      startedRef.current = true;
      setStatus('not-found');
      return;
    }

    startedRef.current = true;
    if (workspace.id === orgId) {
      void router.navigate({ href: link.target, replace: true });
      return;
    }

    // Survives Clerk coming back with the previous org after the reload;
    // the app shell then activates this one (see lib/pending-organization).
    setPendingOrganization(workspace.id);
    setActive({ organization: workspace.id })
      .then(() => {
        try {
          window.localStorage.removeItem('weldsuite:query-cache');
        } catch {
          // storage unavailable — reload anyway
        }
        window.location.replace(link.target);
      })
      .catch(() => setStatus('error'));
  }, [isLoaded, isSignedIn, orgId, orgListLoaded, setActive, userMemberships, memberships, link, router]);

  if (status === 'resolving') {
    return (
      <div className="flex min-h-screen w-full items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t.common.workspaceLink.opening}</span>
        </div>
      </div>
    );
  }

  return <WorkspaceLinkProblem status={status} memberships={memberships} target={link?.target ?? '/'} />;
}
