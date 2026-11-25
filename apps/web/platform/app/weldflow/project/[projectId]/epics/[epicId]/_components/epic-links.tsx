/**
 * The risks, issues and milestones linked to an epic (control links of the
 * RAID log). Read-only: links are made from the RAID log.
 */

import { Link } from '@/lib/router';
import type { LinkedObject } from '@weldsuite/app-api-client/schemas/project-control';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useI18n } from '@/lib/i18n/provider';

function LinkGroup({ title, links }: Readonly<{ title: string; links: readonly LinkedObject[] }>) {
  if (links.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="m-0 list-none space-y-1.5 p-0">
        {links.map((link) => (
          <li key={link.id} className="flex items-start justify-between gap-2 text-sm">
            <span className="min-w-0">
              {link.target.code ? <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">{link.target.code}</span> : null}
              {link.target.title}
            </span>
            <SoftBadge tone="neutral" className="flex-none">
              {link.target.status}
            </SoftBadge>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EpicLinks({
  links,
  loading,
  failed,
  projectId,
}: Readonly<{ links: readonly LinkedObject[]; loading: boolean; failed: boolean; projectId: string }>) {
  const { t } = useI18n();
  const copy = t.flowAgileBacklog.epicPage;
  const risks = links.filter((link) => link.target.type === 'raid_item');
  const milestones = links.filter((link) => link.target.type === 'milestone');

  return (
    <section aria-labelledby="epic-links-heading" className="space-y-3 rounded-lg border border-border p-4">
      <h2 id="epic-links-heading" className="text-sm font-semibold">
        {copy.linked}
      </h2>
      {loading ? <Skeleton className="h-4 w-40" /> : null}
      {failed ? <p className="text-sm text-destructive">{copy.loadLinksFailed}</p> : null}
      {!loading && !failed && links.length === 0 ? <p className="text-sm text-muted-foreground">{copy.noLinks}</p> : null}
      <LinkGroup title={copy.risks} links={risks} />
      <LinkGroup title={copy.milestones} links={milestones} />
      {risks.length > 0 ? (
        <Link href={`/weldflow/project/${projectId}/raid`} className="text-xs font-medium text-primary hover:underline">
          {copy.openRaid}
        </Link>
      ) : null}
    </section>
  );
}
