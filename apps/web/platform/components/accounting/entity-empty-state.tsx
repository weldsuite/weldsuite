import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';
import { CreateEntityDialog } from './create-entity-dialog';

/**
 * Full-module empty state shown when the workspace has no accounting entity yet.
 * Opens the create-entity dialog so the first legal entity can be set up without
 * navigating into entity-scoped pages that would otherwise fail.
 */
export function EntityEmptyState() {
  const { t } = useI18n();
  const tl = t.accounting.layout;
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-16 min-h-[calc(100vh-120px)]">
      <EmptyStateIllustration>
        <svg
          width="120"
          height="120"
          viewBox="0 0 120 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden
        >
          {/* Building silhouette */}
          <rect
            x="28"
            y="34"
            width="64"
            height="58"
            rx="4"
            className="fill-white dark:fill-white/[0.03]"
          />
          <rect
            x="28"
            y="34"
            width="64"
            height="58"
            rx="4"
            className="stroke-gray-200 dark:stroke-white/15"
            strokeWidth="1"
          />
          {/* Roof accent */}
          <rect
            x="28"
            y="34"
            width="64"
            height="8"
            rx="2"
            className="fill-gray-50 dark:fill-white/[0.04]"
          />
          {/* Windows */}
          <rect x="40" y="50" width="12" height="10" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          <rect x="58" y="50" width="12" height="10" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          <rect x="76" y="50" width="8" height="10" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          <rect x="40" y="66" width="12" height="10" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          <rect x="58" y="66" width="12" height="10" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          {/* Door — the literal entry to first-entity setup */}
          <rect x="74" y="66" width="10" height="26" rx="1.5" className="fill-gray-200 dark:fill-white/20" />
        </svg>
      </EmptyStateIllustration>
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{tl.noEntityTitle}</h3>
      <p className="text-sm text-muted-foreground max-w-[360px] leading-relaxed mb-6">
        {tl.noEntityDescription}
      </p>
      <Button onClick={() => setCreateOpen(true)} data-testid="weldbooks-create-first-entity">
        {tl.createFirstEntity}
      </Button>
      <CreateEntityDialog open={createOpen} onOpenChange={setCreateOpen} firstEntity />
    </div>
  );
}
