import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import type { BadgeProps } from '@weldsuite/mobile-ui/components/Badge';
import { statusLabel, useI18n } from '@/lib/i18n';

type Variant = NonNullable<BadgeProps['variant']>;

const AGENT_VARIANTS: Record<string, Variant> = {
  draft: 'outline',
  active: 'success',
  paused: 'secondary',
  queued: 'warning',
  running: 'default',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'outline',
};

export function StatusBadge({
  status,
  size = 'sm',
}: {
  status: string;
  size?: BadgeProps['size'];
}) {
  const { t } = useI18n();
  return (
    <Badge
      variant={AGENT_VARIANTS[status] ?? 'secondary'}
      size={size}
      label={statusLabel(t, status)}
    />
  );
}
