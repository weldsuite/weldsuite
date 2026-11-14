import type { FormStatus } from '@weldsuite/app-api-client/schemas/weldforms';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { useI18n } from '@/lib/i18n/provider';

const TONES: Record<FormStatus, SoftTone> = { draft: 'neutral', published: 'success', closed: 'warning' };

interface Props {
  status: FormStatus;
  /** A published form with a newer draft. */
  hasUnpublishedChanges?: boolean;
}

export function FormStatusBadge({ status, hasUnpublishedChanges }: Readonly<Props>) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5">
      <SoftBadge tone={TONES[status]}>{t.weldforms.status[status]}</SoftBadge>
      {status === 'published' && hasUnpublishedChanges && <SoftBadge tone="warning">{t.weldforms.status.unpublishedChanges}</SoftBadge>}
    </span>
  );
}
