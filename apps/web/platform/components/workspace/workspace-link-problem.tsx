import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { workspacePath } from '@/lib/workspace-url';

export interface WorkspaceLinkMembership {
  id: string;
  slug: string | null;
  name: string;
}

/**
 * A `/w/{workspace}` link that can't open (FE-013): the workspace isn't one of
 * the user's, or switching to it failed. Lists the user's workspaces so the
 * same page can be opened in one of them; never falls back silently to the
 * active one.
 */
export function WorkspaceLinkProblem({
  status,
  memberships,
  target,
}: Readonly<{
  status: 'not-found' | 'error';
  memberships: readonly WorkspaceLinkMembership[];
  /** The in-app path the link pointed at. */
  target: string;
}>) {
  const { t } = useI18n();
  const title = status === 'error' ? t.common.workspaceLink.errorTitle : t.common.workspaceLink.notFoundTitle;
  const description =
    status === 'error' ? t.common.workspaceLink.errorDescription : t.common.workspaceLink.notFoundDescription;

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
