import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { getTranslations } from '@/lib/i18n';
import type { DeskProblemStatus } from '@/hooks/queries/use-desk-problem-queries';

const TONE: Record<DeskProblemStatus, SoftTone> = {
  open: 'neutral',
  investigating: 'warning',
  known_error: 'danger',
  resolved: 'success',
  closed: 'neutral',
};

/** The status of a problem as a pill. */
export function ProblemStatusBadge({ status }: Readonly<{ status: DeskProblemStatus }>) {
  const t = getTranslations('deskProblems');
  return (
    <SoftBadge tone={TONE[status]} data-testid="desk-problem-status">
      {t.status[status]}
    </SoftBadge>
  );
}
