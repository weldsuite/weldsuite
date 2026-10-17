/**
 * The gate of the sales tax record panels (agency, exemption certificate).
 *
 * The standalone pages sat inside `SalesTaxSetupGate`: nothing of sales tax
 * shows until the entity's jurisdiction is known, and only for a US entity and
 * a member who can read taxes. A panel opens from a link anywhere, so it makes
 * the same check itself: when the gate is not open it shows the shell with the
 * reason in its body, and only when it is open does it mount `children`, whose
 * queries therefore never run for an entity that has no sales tax.
 */

import type { ReactNode } from 'react';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { useSalesTaxSetupGate } from '@/app/weldbooks/sales-tax/setup/setup-gate';
import { useSetupTexts } from '@/app/weldbooks/sales-tax/setup/setup-texts';

export function SalesTaxPanelGate({
  panelProps,
  width,
  title,
  avatar,
  children,
}: Readonly<{
  panelProps: ObjectPanelComponentProps;
  width: number;
  /** Shown in the header while there is no record to name. */
  title: string;
  avatar: ReactNode;
  children: ReactNode;
}>) {
  const status = useSalesTaxSetupGate();
  if (status === 'ready') return <>{children}</>;
  return <GatedPanel panelProps={panelProps} width={width} title={title} avatar={avatar} status={status} />;
}

function GatedPanel({
  panelProps,
  width,
  title,
  avatar,
  status,
}: Readonly<{
  panelProps: ObjectPanelComponentProps;
  width: number;
  title: string;
  avatar: ReactNode;
  status: Exclude<ReturnType<typeof useSalesTaxSetupGate>, 'ready'>;
}>) {
  const { t } = useSetupTexts();
  const shell = useObjectPanelShell({ ...panelProps, width, loading: status === 'loading' });
  const messages = {
    loading: null,
    'load-error': t.common.loadError,
    'us-only': t.common.usOnly,
    'no-access': t.common.noAccess,
  } as const;
  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      avatar={avatar}
      title={<span className="truncate text-[15px] font-medium text-foreground">{title}</span>}
    >
      <p className="p-6 text-sm text-muted-foreground" role={status === 'load-error' ? 'alert' : undefined}>
        {messages[status]}
      </p>
    </EntityDetailView>
  );
}
