/**
 * The Integrations tab's pieces drawn as the App Store draws apps: the logo
 * on a bordered tile, the card with name, subtitle and description, and the
 * status badge in its corner.
 */

import type { ComponentType, ReactNode } from 'react';
import type { FormIntegration } from '@weldsuite/app-api-client/schemas/weldforms';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { getAppLogo, getAppLucideIcon } from '@/lib/apps/app-registry';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

/** An app's logo on the App Store's 40px tile; `icon` stands in when there is no app behind it. */
export function IntegrationLogo({ code, icon }: Readonly<{ code?: string; icon?: ComponentType<{ className?: string }> }>) {
  const logoPath = code ? getAppLogo(code, 'light') : undefined;
  const Icon = icon ?? getAppLucideIcon(code ?? '');
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-[0.625rem] border border-gray-200 bg-white dark:border-border dark:bg-background">
      {logoPath ? <img src={logoPath} alt="" className="size-5 object-contain" /> : <Icon className="size-5" />}
    </div>
  );
}

/** Where an integration stands: failing, on (the App Store's "Installed" blue) or off; nothing when it is not set up. */
export function IntegrationStatus({ integration, className }: Readonly<{ integration: FormIntegration | null; className?: string }>) {
  const { t } = useI18n();
  const ti = t.weldformsResults.integrations;
  if (!integration) return null;
  if (integration.lastError) {
    return (
      <SoftBadge tone="danger" className={cn('rounded', className)}>
        {ti.statusFailed}
      </SoftBadge>
    );
  }
  if (!integration.enabled) {
    return (
      <Badge variant="secondary" className={cn('rounded', className)}>
        {ti.statusOff}
      </Badge>
    );
  }
  return <Badge className={cn('rounded border-transparent bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400', className)}>{ti.statusOn}</Badge>;
}

const CARD = 'relative block w-full rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-border/80 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface AppCardProps {
  logo: ReactNode;
  name: string;
  subtitle: string;
  description: string;
  badge?: ReactNode;
}

function AppCardBody({ logo, name, subtitle, description, badge }: Readonly<AppCardProps>) {
  return (
    <>
      {badge ? <span className="absolute top-3 right-3">{badge}</span> : null}
      <span className="flex flex-col gap-3">
        <span className="flex items-start gap-3">
          {logo}
          <span className="relative top-px min-w-0">
            <span className="mb-px block text-[0.9375rem] font-semibold text-foreground">{name}</span>
            <span className="block text-xs text-muted-foreground">{subtitle}</span>
          </span>
        </span>
        <span className="line-clamp-2 text-sm leading-[1.4] text-muted-foreground">{description}</span>
      </span>
    </>
  );
}

/** A card that opens the integration's settings in place. */
export function AppCardButton({ onClick, ...props }: Readonly<AppCardProps & { onClick: () => void }>) {
  return (
    <button type="button" onClick={onClick} className={CARD}>
      <AppCardBody {...props} />
    </button>
  );
}

/** The App Store's category heading. */
export const CATEGORY_TITLE = 'text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase';

/**
 * The top of an opened integration: a Back button to the cards above the
 * logo, name with its status and description, then `children` under it (the
 * open button) and `aside` on the right (the enable switch).
 */
export function IntegrationHeader({
  logo,
  title,
  badge,
  description,
  onBack,
  aside,
  children,
  className,
}: Readonly<{ logo: ReactNode; title: string; badge?: ReactNode; description: string; onBack: () => void; aside?: ReactNode; children?: ReactNode; className?: string }>) {
  const { t } = useI18n();
  return (
    <div className={cn('space-y-4', className)}>
      <Button type="button" variant="ghost" size="sm" className="-ml-2.5 text-muted-foreground" onClick={onBack}>
        <ChevronLeft />
        {t.common.actions.back}
      </Button>
      <div className="flex flex-wrap items-start gap-3">
        {logo}
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="flex flex-wrap items-center gap-2 text-lg leading-tight font-semibold">
            {title}
            {badge}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
          {children ? <div className="pt-3">{children}</div> : null}
        </div>
        {aside ? <div className="flex items-center gap-2 pt-2">{aside}</div> : null}
      </div>
    </div>
  );
}
