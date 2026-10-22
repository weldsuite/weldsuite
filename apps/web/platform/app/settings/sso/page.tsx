import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useSsoConfig } from '@/hooks/queries/use-sso-queries';
import { SsoActivateStep } from './sso-activate-step';
import { SsoAddonCard } from './sso-addon-card';
import { SsoConnectionStep } from './sso-connection-step';
import { SsoDomainStep } from './sso-domain-step';
import { Notice } from './sso-parts';
import { ssoStatus, type SsoStatus } from './sso-view';

const STATUS_BADGE: Record<SsoStatus, 'success' | 'secondary' | 'outline'> = {
  active: 'success',
  off: 'secondary',
  not_set_up: 'outline',
};

/**
 * Settings > Single sign-on: buy the add-on, prove the company domain,
 * connect the identity provider, switch it on. Anyone with `sso:read` sees the
 * page; changing it takes `sso:manage` (the configuration says whether the
 * caller has it) and the add-on's billing takes `billing:manage`.
 */
export default function SsoSettingsPage() {
  const { t } = useI18n();
  const ts = t.settings.sso;
  const { can, isLoading: permissionsLoading } = usePermissions();
  const canRead = can('sso:read');
  const { data: config, isLoading, isError, refetch } = useSsoConfig(canRead);

  if (permissionsLoading || (canRead && isLoading)) {
    return <PageLoader fullScreen={false} />;
  }

  if (!canRead) {
    return (
      <AccessDeniedEmptyState
        description={ts.accessDeniedDescription}
        permission="sso:read"
        pageLabel={ts.pageLabel}
      />
    );
  }

  if (isError || !config) {
    return (
      <div className="max-w-4xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
          <p className="text-sm text-muted-foreground">{ts.loadFailed}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
            {ts.retry}
          </Button>
        </div>
      </div>
    );
  }

  const status = ssoStatus(config);
  const statusLabel: Record<SsoStatus, string> = {
    active: ts.status.active,
    off: ts.status.off,
    not_set_up: ts.status.notSetUp,
  };
  const canManage = config.canManage;

  return (
    <div className="max-w-4xl space-y-8">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
          <Badge variant={STATUS_BADGE[status]}>{statusLabel[status]}</Badge>
        </div>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>

      {!canManage && <Notice>{ts.readOnlyNotice}</Notice>}

      <SsoAddonCard />

      <div className="space-y-4">
        <SsoDomainStep config={config} canManage={canManage} />
        <SsoConnectionStep config={config} canManage={canManage} />
        <SsoActivateStep config={config} canManage={canManage} />
      </div>
    </div>
  );
}
