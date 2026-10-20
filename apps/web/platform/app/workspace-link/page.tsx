import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useAuth, useOrganizationList } from '@clerk/clerk-react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { setPendingOrganization } from '@/lib/pending-organization';
import {
  findWorkspace,
  parseWorkspacePath,
  sameOriginPath,
  workspacePath,
  type WorkspaceRef,
} from '@/lib/workspace-url';

interface Membership extends WorkspaceRef {
  name: string;
}

type Status = 'resolving' | 'not-found' | 'error';

/**
 * `/w/{ref}/…` (FE-013): open the inner path in the workspace the link names.
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

  const title = status === 'error' ? t.common.workspaceLink.errorTitle : t.common.workspaceLink.notFoundTitle;
  const description =
    status === 'error' ? t.common.workspaceLink.errorDescription : t.common.workspaceLink.notFoundDescription;
  const target = link?.target ?? '/';

  return (
    <div className="flex min-h-screen w-full items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        {status === 'not-found' && memberships.length > 0 && (
          <div className="space-y-2 text-left">
            <p className="text-sm font-medium">{t.common.workspaceLink.openIn}</p>
            <ul className="divide-y rounded-md border">
              {memberships.map((m) => (
                <li key={m.id}>
                  <a
                    href={workspacePath(m.slug ?? m.id, target)}
                    className="block px-4 py-3 text-sm hover:bg-muted"
                  >
                    {m.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Button asChild variant="outline">
          <a href="/">{t.common.workspaceLink.goHome}</a>
        </Button>
      </div>
    </div>
  );
}
