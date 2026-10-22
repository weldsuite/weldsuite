'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import type { SsoAdminView } from '@weldsuite/app-api-client/schemas/sso';
import { adminCopy, fill } from '@/lib/i18n';
import { formatCents, formatDateTime, formatDay, statusLabel, statusTone } from '@/lib/billing-format';
import type { SsoViewState } from '@/lib/billing-types';
import { ssoCopy, type SsoCopy } from '@/lib/sso-copy';
import { canRevokeSso, connectionInactiveReason, liveSsoSubscription } from '@/lib/sso-admin';
import { Notice } from './subscription-card';
import { SsoDisableConnectionDialog, SsoPriceDialog, SsoRevokeDialog } from './sso-dialogs';

type DialogKind = 'price' | 'revoke' | 'disable';
type Row = [string, React.ReactNode];

function entitlementLabel(t: SsoCopy, view: SsoAdminView): string {
  const source = view.entitlement.entitled ? view.entitlement.source : null;
  return source ? t.entitlement[source] : t.entitlement.none;
}

function providerLabel(t: SsoCopy, provider: string): string {
  return (t.providers as Record<string, string>)[provider] ?? provider;
}

/**
 * The workspace's single sign-on: why it may use it, what it pays, the add-on
 * subscription and the connection. Staff can set a custom or free price
 * (optionally starting the add-on), revoke it, or switch off a connection
 * that locks people out. Every change runs in the billing worker.
 */
export function SsoCard({
  workspaceId,
  state,
  canWrite,
}: Readonly<{ workspaceId: string; state: SsoViewState; canWrite: boolean }>) {
  const t = ssoCopy();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const close = () => setDialog(null);

  const view = state.kind === 'ok' ? state.view : null;
  // The dialogs work from the loaded view, so they need it.
  const actionsEnabled = canWrite && view !== null;

  return (
    <Card className="py-4">
      <CardContent className="space-y-4 px-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">{t.title}</h2>
          {view && (
            <Badge variant={view.entitlement.entitled ? 'success' : 'secondary'}>{entitlementLabel(t, view)}</Badge>
          )}
        </div>

        {state.kind === 'not_configured' && <Notice tone="warning">{t.notConfigured}</Notice>}
        {state.kind === 'error' && <Notice tone="warning">{fill(t.loadFailed, { message: state.message })}</Notice>}

        {view && <SsoDetails view={view} />}

        {view && actionsEnabled && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button size="sm" onClick={() => setDialog('price')}>
              {t.actions.setPrice}
            </Button>
            {canRevokeSso(view) && (
              <Button size="sm" variant="outline" onClick={() => setDialog('revoke')}>
                {t.actions.revoke}
              </Button>
            )}
            {view.connection?.enabled && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setDialog('disable')}
              >
                {t.actions.disableConnection}
              </Button>
            )}
          </div>
        )}
      </CardContent>

      {view && dialog === 'price' && <SsoPriceDialog workspaceId={workspaceId} view={view} onClose={close} />}
      {view && dialog === 'revoke' && <SsoRevokeDialog workspaceId={workspaceId} view={view} onClose={close} />}
      {dialog === 'disable' && <SsoDisableConnectionDialog workspaceId={workspaceId} onClose={close} />}
    </Card>
  );
}

/** "€100.00 / month"; a null amount is one Stripe could not be asked for. */
function perMonth(t: SsoCopy, cents: number | null, currency: string | null): string {
  return cents == null ? t.addon.chargedUnknown : fill(t.perMonth, { amount: formatCents(cents, currency) });
}

function SsoDetails({ view }: Readonly<{ view: SsoAdminView }>) {
  const t = ssoCopy();
  return (
    <div className="space-y-4">
      {view.billingMode === 'partner' && <p className="text-sm text-muted-foreground">{t.partnerNote}</p>}
      <AccessSection t={t} view={view} />
      <AddonSection t={t} view={view} />
      <ConnectionSection t={t} view={view} />
    </div>
  );
}

function AccessSection({ t, view }: Readonly<{ t: SsoCopy; view: SsoAdminView }>) {
  const override = view.priceOverride;
  let customPrice: string;
  if (override === null) customPrice = t.access.noCustomPrice;
  else if (override.unitAmountCents === 0) customPrice = t.access.free;
  else customPrice = perMonth(t, override.unitAmountCents, override.currency ?? view.listPrice.currency);

  const rows: Row[] = [
    [t.access.entitlement, entitlementLabel(t, view)],
    [t.access.listPrice, perMonth(t, view.listPrice.unitAmountCents, view.listPrice.currency)],
    [t.access.customPrice, customPrice],
    [t.access.billing, view.billingMode === 'partner' ? t.access.billingPartner : t.access.billingDirect],
  ];

  return (
    <Section title={t.sections.access}>
      <Rows rows={rows} />
      {override && (
        <p className="text-xs text-muted-foreground">
          {fill(t.access.priceSetBy, { email: override.setBy ?? '—', date: formatDateTime(override.setAt) })}
          {override.reason ? ` “${override.reason}”` : ''}
        </p>
      )}
    </Section>
  );
}

function AddonSection({ t, view }: Readonly<{ t: SsoCopy; view: SsoAdminView }>) {
  const sub = view.subscription;
  if (!sub) {
    return (
      <Section title={t.sections.addon}>
        <p className="text-sm text-muted-foreground">{t.addon.none}</p>
      </Section>
    );
  }

  const live = liveSsoSubscription(view);
  const rows: Row[] = [
    [t.addon.status, <Badge key="status" variant={statusTone(sub.status)}>{statusLabel(adminCopy(), sub.status)}</Badge>],
  ];
  // What a cancelled add-on charged or when it renewed no longer matters.
  if (live) {
    rows.push(
      [t.addon.charged, perMonth(t, live.unitAmountCents, live.currency)],
      [live.cancelAtPeriodEnd ? t.addon.endsOn : t.addon.renewsOn, formatDay(live.currentPeriodEnd)],
    );
  }
  rows.push([t.addon.stripe, <span key="stripe" className="font-mono text-xs">{sub.id}</span>]);

  return (
    <Section title={t.sections.addon}>
      <Rows rows={rows} />
    </Section>
  );
}

function ConnectionSection({ t, view }: Readonly<{ t: SsoCopy; view: SsoAdminView }>) {
  const connection = view.connection;
  const domain = view.domain ? (
    <span key="domain" className="inline-flex items-center gap-2">
      <span className="font-mono text-xs">{view.domain.name}</span>
      <Badge variant={view.domain.verified ? 'success' : 'warning'}>
        {view.domain.verified ? t.connection.verified : t.connection.unverified}
      </Badge>
    </span>
  ) : (
    t.connection.noDomain
  );

  const rows: Row[] = [[t.connection.domain, domain]];
  if (connection) {
    rows.push(
      [t.connection.provider, providerLabel(t, connection.provider)],
      [t.connection.enabled, connection.enabled ? t.yes : t.no],
      [t.connection.active, connection.active ? t.yes : t.no],
    );
    if (connection.updatedAt || connection.updatedBy) {
      rows.push([
        t.connection.lastChanged,
        fill(t.connection.changedBy, { date: formatDateTime(connection.updatedAt), email: connection.updatedBy ?? '—' }),
      ]);
    }
  }

  const inactive = connectionInactiveReason(view);
  const inactiveNotes = {
    domain: t.connection.inactiveDomain,
    entitlement: t.connection.inactiveEntitlement,
    pending: t.connection.inactivePending,
  };

  return (
    <Section title={t.sections.connection}>
      <Rows rows={rows} />
      {!connection && <p className="text-sm text-muted-foreground">{t.connection.none}</p>}
      {inactive && <Notice tone="warning">{inactiveNotes[inactive]}</Notice>}
    </Section>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

/** Label/value pairs, laid out like the subscription card's. */
function Rows({ rows }: Readonly<{ rows: Row[] }>) {
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 border-b border-border/50 pb-1.5">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
