import { Flag, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { LinkedObject, RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCreateControlLink,
  useDeleteControlLink,
  useProjectMilestones,
} from '@/hooks/queries/use-project-control-queries';
import { intlLocaleOf } from '../_lib/locale';
import { formatShortDate } from '../_lib/raid';
import { useRaid } from './raid-context';

interface MilestoneRowProps {
  item: RaidItem;
  /** The milestone links of the item (`threatens` / `affects`). */
  links: LinkedObject[];
}

/** The milestone a risk threatens: its name and date, and for editors a way to link or unlink one. */
export function MilestoneValue({ item, links }: Readonly<MilestoneRowProps>) {
  const { t, language } = useI18n();
  const copy = t.projects.raid.detail;
  const toasts = t.projects.raid.toasts;
  const { projectId, abilities, now } = useRaid();
  const milestones = useProjectMilestones(projectId, abilities.update && links.length === 0);
  const createLink = useCreateControlLink();
  const deleteLink = useDeleteControlLink();
  const intlLocale = intlLocaleOf(language);

  const link = async (milestoneId: string) => {
    try {
      await createLink.mutateAsync({
        fromType: 'raid_item',
        fromId: item.id,
        toType: 'milestone',
        toId: milestoneId,
        relation: 'threatens',
      });
      toast.success(toasts.milestoneLinked);
    } catch {
      toast.error(toasts.linkFailed);
    }
  };

  const unlink = async (linkId: string) => {
    try {
      await deleteLink.mutateAsync(linkId);
      toast.success(toasts.milestoneUnlinked);
    } catch {
      toast.error(toasts.unlinkFailed);
    }
  };

  if (links.length > 0) {
    return (
      <ul className="flex flex-col gap-1">
        {links.map((milestoneLink) => (
          <li key={milestoneLink.id} className="flex items-center gap-1.5">
            <Flag aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{milestoneLink.target.title}</span>
            {milestoneLink.target.dueDate ? (
              <span className="shrink-0 text-muted-foreground">· {formatShortDate(milestoneLink.target.dueDate, intlLocale, now)}</span>
            ) : null}
            {abilities.update ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void unlink(milestoneLink.id)}
                disabled={deleteLink.isPending}
                aria-label={copy.removeMilestone}
                title={copy.removeMilestone}
              >
                <X aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  const options = milestones.data ?? [];
  if (!abilities.update || options.length === 0) {
    return <span className="text-muted-foreground">{copy.noMilestone}</span>;
  }
  return (
    <Select value="" onValueChange={(milestoneId) => void link(milestoneId)} disabled={createLink.isPending}>
      <SelectTrigger size="sm" className="h-7 w-full max-w-60 text-xs" aria-label={copy.linkMilestone}>
        <SelectValue placeholder={copy.linkMilestone} />
      </SelectTrigger>
      <SelectContent>
        {options.map((milestone) => (
          <SelectItem key={milestone.id} value={milestone.id}>
            {milestone.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
