import type { Dictionary } from '@/lib/i18n';
import type { HrMilestoneStatus } from '@/lib/types';

/**
 * `HrMilestoneStatus`'s `in_progress` doesn't match the dictionary's
 * camelCase `inProgress` key, so this maps status → label explicitly instead
 * of indexing `dict.client.milestones` with the raw status (which TS can't
 * narrow away from the full union at each access site anyway).
 */
export function milestoneStatusLabel(dict: Dictionary, status: HrMilestoneStatus): string {
  switch (status) {
    case 'achieved':
      return dict.client.milestones.achieved;
    case 'planned':
      return dict.client.milestones.planned;
    case 'in_progress':
      return dict.client.milestones.inProgress;
    case 'missed':
      return dict.client.milestones.missed;
  }
}
