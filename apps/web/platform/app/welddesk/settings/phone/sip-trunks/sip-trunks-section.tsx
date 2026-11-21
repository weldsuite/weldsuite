/**
 * "Your own phone system" on the WeldDesk phone settings page: the connected
 * SIP trunks / PBXes (Xelion, Dstny, ...), a wizard to connect one and a dialog
 * to manage it. Its numbers also show in the numbers list above, labelled with
 * their phone system.
 */

import { useState } from 'react';
import { PhoneForwarded, Plus } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { getTranslations } from '@/lib/i18n';
import { useDeskSipTrunks } from '@/hooks/queries/use-desk-sip-trunk-queries';
import { ConnectSipTrunkDialog } from './connect-sip-trunk-dialog';
import { ManageSipTrunkDialog } from './manage-sip-trunk-dialog';

export function SipTrunksSection() {
  const t = getTranslations('deskSipTrunks');
  const canEdit = useCan('settings:manage');
  const trunks = useDeskSipTrunks();
  const [connecting, setConnecting] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  // Read from the live list, so the dialog follows edits.
  const managing = trunks.data?.find((trunk) => trunk.id === managingId) ?? null;

  let body: React.ReactNode;
  if (trunks.isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (trunks.isError) {
    body = <ErrorState message={t.section.loadError} onRetry={() => void trunks.refetch()} />;
  } else if (!trunks.data || trunks.data.length === 0) {
    body = (
      <EmptyState
        icon={PhoneForwarded}
        title={t.section.emptyTitle}
        description={t.section.emptyDescription}
        action={
          canEdit ? (
            <Button onClick={() => setConnecting(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t.section.connect}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <ul className="divide-y rounded-lg border" data-testid="sip-trunk-list">
        {trunks.data.map((trunk) => (
          <li key={trunk.id} className="flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap" data-testid="sip-trunk-row">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{trunk.name}</span>
                <SoftBadge tone="neutral">{t.providers[trunk.provider]}</SoftBadge>
                <SoftBadge tone={trunk.status === 'active' ? 'success' : 'warning'}>{t.status[trunk.status]}</SoftBadge>
              </div>
              <p className="text-sm text-muted-foreground">
                {t.list.numbersCount.replace('{count}', String(trunk.numbers.length))}
                {' · '}
                {trunk.lastInboundAt
                  ? t.list.lastCall.replace('{when}', new Date(trunk.lastInboundAt).toLocaleString())
                  : t.list.noCalls}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setManagingId(trunk.id)}
              aria-label={t.list.manageFor.replace('{name}', trunk.name)}
            >
              {t.list.manage}
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="space-y-4" data-testid="sip-trunks-section">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{t.section.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.section.description}</p>
        </div>
        {canEdit && trunks.data && trunks.data.length > 0 && (
          <Button variant="outline" onClick={() => setConnecting(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t.section.connect}
          </Button>
        )}
      </div>
      {body}
      <ConnectSipTrunkDialog open={connecting} onOpenChange={setConnecting} canEdit={canEdit} />
      <ManageSipTrunkDialog
        trunk={managing}
        onOpenChange={(open) => !open && setManagingId(null)}
        canEdit={canEdit}
      />
    </section>
  );
}
