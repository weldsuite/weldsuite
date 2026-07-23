/**
 * `ComingSoonTab` — neutral empty-state for object-panel tabs whose data
 * source isn't wired yet (Activity / Emails / Calls / Pipeline / Notes /
 * Meetings / Tasks / Files / Audit Log on the company + person panels).
 *
 * The plan from /weldcrm/companies/[id]/page.tsx is that these tabs come
 * online once the cross-module rewrites land — until then, this component
 * keeps the visual silhouette of the panel consistent without faking data.
 */

import type { ComponentType } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';

interface ComingSoonTabProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** Optional one-liner explaining what will live here once it's built. */
  description?: string;
}

export function ComingSoonTab({ icon: Icon, label, description }: ComingSoonTabProps) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-12 gap-2">
      <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="text-sm font-medium text-foreground">{label}</div>
      <p className="text-xs text-muted-foreground max-w-[42ch]">
        {description ?? t('sweep.entities.comingSoonDescription')}
      </p>
    </div>
  );
}
