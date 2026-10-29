/**
 * Install tab: whether the snippet works yet, and the snippets to paste.
 * Everyone who can read the project sees it, token included: the token is
 * public and can only send data.
 */

import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { useWeldPanelInstall } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { CopyBlock } from '../components/copy-block';
import { InstallStatus } from '../components/install-status';

export function InstallTab({ project }: Readonly<{ project: PanelProjectDto }>) {
  const { t } = useI18n();
  const ti = t.weldpanel.install;
  // The same query as the status card's, so this costs no extra request.
  const { data: install, isLoading, isFetching } = useWeldPanelInstall(project.id);
  // After a token rotation the old snippet stays cached until the refetch lands: never show it.
  const current = install && install.token === project.token ? install : undefined;
  const loading = isLoading || (isFetching && !current);

  return (
    <div className="space-y-6">
      <InstallStatus projectId={project.id} paused={project.status === 'paused'} />

      {/* On a failed check the status card says so and offers a retry; there is nothing to show here. */}
      {(loading || current) && (
        <div className="space-y-6 rounded-lg border bg-card p-4 sm:p-5">
          {loading && (
            <div className="space-y-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {current && (
            <>
              <CopyBlock title={ti.scriptTitle} description={ti.scriptDescription} value={current.scriptSnippet} />
              <CopyBlock title={ti.npmTitle} description={ti.npmDescription} value={current.npmSnippet} />
              <CopyBlock title={ti.tokenLabel} description={ti.tokenHint} value={current.token} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
