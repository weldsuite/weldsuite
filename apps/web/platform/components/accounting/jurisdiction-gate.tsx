import type { ComponentType, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Landmark } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction, type CurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';

interface JurisdictionUnavailableProps {
  /** Name of the feature, shown in the title ("{feature} isn't available for …"). */
  feature: string;
  /** Name of the entity's country; "these" is used while it is unknown. */
  country?: string | null;
  /** Replaces the standard title, for a screen that has its own wording. */
  title?: string;
  /** Replaces the standard description. */
  description?: string;
  icon?: ComponentType<{ className?: string }>;
}

/** The one "not available for this country" screen, with a button back to the WeldBooks dashboard. */
export function JurisdictionUnavailable({
  feature,
  country,
  title,
  description,
  icon = Landmark,
}: Readonly<JurisdictionUnavailableProps>) {
  const { t } = useI18n();
  const tg = t.accounting.jurisdictionGate;
  return (
    <div className="p-4 sm:p-6">
      <EmptyState
        icon={icon}
        title={title ?? tg.title.replace('{feature}', feature).replace('{country}', country || tg.unknownCountry)}
        description={description ?? tg.description}
        action={
          <Button asChild variant="outline">
            <Link to="/weldbooks/dashboard">{tg.back}</Link>
          </Button>
        }
      />
    </div>
  );
}

interface JurisdictionGateProps {
  /** True when the selected entity's jurisdiction offers the feature. Read `features`, not the country code, where a flag exists. */
  when: (jurisdiction: CurrentJurisdiction) => boolean;
  /** Name of the feature, for the title of the not-available screen. */
  feature: string;
  children: ReactNode;
}

/**
 * Shows `children` only for an entity whose jurisdiction passes `when`. Waits
 * (loader) while the jurisdiction is unknown, shows an error state when it
 * could not be loaded, and otherwise the shared not-available screen. Nothing
 * inside is mounted until the gate is open, so its queries never run for an
 * entity that does not have the feature.
 */
export function JurisdictionGate({ when, feature, children }: Readonly<JurisdictionGateProps>) {
  const current = useCurrentJurisdiction();

  if (!current.isResolved) {
    if (current.isError) return <ErrorState className="m-4 sm:m-6" />;
    return <PageLoader fullScreen={false} />;
  }
  if (!when(current)) {
    return <JurisdictionUnavailable feature={feature} country={current.jurisdiction?.name} />;
  }
  return <>{children}</>;
}
