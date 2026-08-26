/**
 * Status pills for projects and tasks.
 *
 * Colour mapping matches the platform's WeldFlow tables so a row reads the
 * same on both surfaces.
 */

import React from 'react';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import type { BadgeProps } from '@weldsuite/mobile-ui/components/Badge';
import { statusLabel, useI18n } from '@/lib/i18n';

type Variant = NonNullable<BadgeProps['variant']>;

const TASK_VARIANTS: Record<string, Variant> = {
  backlog: 'secondary',
  todo: 'default',
  in_progress: 'warning',
  in_review: 'default',
  testing: 'default',
  done: 'success',
  cancelled: 'outline',
};

const PROJECT_VARIANTS: Record<string, Variant> = {
  Planning: 'default',
  Active: 'success',
  OnHold: 'warning',
  Completed: 'secondary',
  Cancelled: 'outline',
};

export function TaskStatusBadge({
  status,
  size = 'sm',
}: {
  status: string;
  size?: BadgeProps['size'];
}) {
  const { t } = useI18n();
  return (
    <Badge
      variant={TASK_VARIANTS[status] ?? 'secondary'}
      size={size}
      label={statusLabel(t, status)}
    />
  );
}

export function ProjectStatusBadge({
  status,
  size = 'sm',
}: {
  status: string;
  size?: BadgeProps['size'];
}) {
  const { t } = useI18n();
  return (
    <Badge
      variant={PROJECT_VARIANTS[status] ?? 'secondary'}
      size={size}
      label={statusLabel(t, status)}
    />
  );
}

/** @deprecated Prefer TaskStatusBadge / ProjectStatusBadge. */
export function StatusBadge({ status }: { status: string }) {
  if (status in PROJECT_VARIANTS) {
    return <ProjectStatusBadge status={status} />;
  }
  return <TaskStatusBadge status={status} />;
}
