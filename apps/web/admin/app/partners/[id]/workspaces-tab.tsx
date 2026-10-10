'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link2, Pencil, Unlink } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  attachPartnerWorkspace,
  detachPartnerWorkspace,
  searchWorkspacesToAttach,
  updatePartnerWorkspaceLicence,
} from '@/actions/partners';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import { LicenceStatusBadge } from '@/components/partners/badges';
import { LicenceFields, type AppOption } from '@/components/partners/licence-fields';
import { formatCredits, formatDecimal } from '@/lib/billing-format';
import type { PlanOption } from '@/lib/billing-types';
import { fill } from '@/lib/i18n';
import {
  defaultLicenceForm,
  licenceFormFromSnapshot,
  licencePayload,
  parseLicenceForm,
  type AdminLicence,
  type AdminPartnerWorkspace,
} from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';
import type { PartnerTabProps } from './partner-detail';

type Dialog =
  | { kind: 'attach' }
  | { kind: 'edit'; workspace: AdminPartnerWorkspace }
  | { kind: 'detach'; workspace: AdminPartnerWorkspace };

export function WorkspacesTab({ detail, canWrite, planOptions, appOptions }: Readonly<PartnerTabProps>) {
  const t = partnersCopy().workspaces;
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const done = () => router.refresh();

  return (
    <div className="space-y-4">
      <Card className="py-4">
        <CardContent className="space-y-3 px-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium">{t.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
            </div>
            {canWrite && (
              <Button size="sm" onClick={() => setDialog({ kind: 'attach' })}>
                <Link2 className="h-4 w-4" />
                {t.attach}
              </Button>
            )}
          </div>

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.columns.workspace}</TableHead>
                  <TableHead className="w-28">{t.columns.status}</TableHead>
                  <TableHead>{t.columns.apps}</TableHead>
                  <TableHead className="w-32 text-right">{t.columns.credits}</TableHead>
                  <TableHead className="w-24 text-right">{t.columns.seats}</TableHead>
                  <TableHead className="w-44">{t.columns.price}</TableHead>
                  {canWrite && <TableHead className="w-40" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.workspaces.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={canWrite ? 7 : 6} className="py-12 text-center text-sm text-muted-foreground">
                      {t.empty}
                    </TableCell>
                  </TableRow>
                )}
                {detail.workspaces.map((w) => (
                  <TableRow key={w.workspaceId}>
                    <TableCell>
                      <a href={`/workspaces/${w.workspaceId}`} className="font-medium underline-offset-2 hover:underline">
                        {w.name}
                      </a>
                      <div className="font-mono text-[11px] text-muted-foreground">{w.workspaceId}</div>
                    </TableCell>
                    <TableCell>{w.licence ? <LicenceStatusBadge status={w.licence.status} /> : <Badge variant="outline">{t.noLicence}</Badge>}</TableCell>
                    <TableCell className="text-xs">
                      {w.licence ? <AppsSummary apps={w.licence.allowedApps} appOptions={appOptions} /> : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{w.licence ? formatCredits(w.licence.monthlyCredits) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {w.licence ? (w.licence.maxSeats ?? partnersCopy().common.unlimited) : '—'}
                    </TableCell>
                    <TableCell className="text-sm">{w.licence ? <PriceSummary licence={w.licence} /> : '—'}</TableCell>
                    {canWrite && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon-sm" aria-label={t.editLicence} title={t.editLicence} onClick={() => setDialog({ kind: 'edit', workspace: w })}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label={t.detach} title={t.detach} onClick={() => setDialog({ kind: 'detach', workspace: w })}>
                            <Unlink className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {dialog?.kind === 'attach' && (
        <AttachDialog partnerId={detail.partner.id} appOptions={appOptions} planOptions={planOptions} onClose={close} onDone={done} />
      )}
      {dialog?.kind === 'edit' && (
        <EditLicenceDialog
          partnerId={detail.partner.id}
          workspace={dialog.workspace}
          appOptions={appOptions}
          planOptions={planOptions}
          onClose={close}
          onDone={done}
        />
      )}
      {dialog?.kind === 'detach' && (
        <ActionDialog
          title={fill(t.detachTitle, { name: dialog.workspace.name })}
          description={t.detachHint}
          submitLabel={t.detachSubmit}
          destructive
          onSubmit={(reason, requestId) => detachPartnerWorkspace(detail.partner.id, dialog.workspace.workspaceId, { reason }, requestId)}
          successMessage={t.detached}
          onClose={() => {
            close();
            done();
          }}
        />
      )}
    </div>
  );
}

function AppsSummary({ apps, appOptions }: Readonly<{ apps: string[]; appOptions: AppOption[] }>) {
  const t = partnersCopy().workspaces;
  if (apps.includes('*')) return <span>{t.allApps}</span>;
  if (apps.length === 0) return <span className="text-muted-foreground">{partnersCopy().common.none}</span>;
  const names = apps.map((code) => appOptions.find((a) => a.code === code)?.name ?? code);
  return <span title={names.join(', ')}>{names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`}</span>;
}

function PriceSummary({ licence }: Readonly<{ licence: AdminLicence }>) {
  const t = partnersCopy().workspaces;
  const p = licence.resalePricing;
  const amount = formatDecimal(p.amount, 'USD');
  if (p.model === 'flat') return <>{fill(t.flat, { amount })}</>;
  return <>{p.minSeats ? fill(t.perSeatMin, { amount, min: p.minSeats }) : fill(t.perSeat, { amount })}</>;
}

function AttachDialog({
  partnerId,
  appOptions,
  planOptions,
  onClose,
  onDone,
}: Readonly<{ partnerId: string; appOptions: AppOption[]; planOptions: PlanOption[]; onClose: () => void; onDone: () => void }>) {
  const t = partnersCopy().workspaces;
  const [workspaceId, setWorkspaceId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ id: string; name: string; slug: string }>>([]);
  const [licence, setLicence] = useState(defaultLicenceForm);
  const [cancelMode, setCancelMode] = useState<'now' | 'period_end'>('period_end');

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    let stale = false;
    const timer = setTimeout(async () => {
      const result = await searchWorkspacesToAttach(query);
      if (!stale && result.ok) setResults(result.data);
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  const parsed = parseLicenceForm(licence);
  const invalid = workspaceId.trim() === '' ? `${t.workspaceId}: required` : parsed.ok ? null : parsed.error;

  return (
    <ActionDialog
      wide
      title={t.attachTitle}
      description={t.attachHint}
      submitLabel={t.attachSubmit}
      invalidMessage={invalid}
      onSubmit={(reason, requestId) =>
        attachPartnerWorkspace(
          partnerId,
          { workspaceId: workspaceId.trim(), licence: { ...licencePayload(licence), packageId: null }, cancelDirectSubscription: cancelMode, reason },
          requestId,
        )
      }
      successMessage={t.attached}
      onClose={() => {
        onClose();
        onDone();
      }}
    >
      <Field label={t.findWorkspace} htmlFor="attach-search">
        <Input id="attach-search" value={query} onChange={(e) => setQuery(e.target.value)} />
        {results.length > 0 && (
          <ul className="mt-1 max-h-40 overflow-auto rounded-md border text-sm">
            {results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    setWorkspaceId(r.id);
                    setQuery('');
                    setResults([]);
                  }}
                >
                  <span>{r.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{r.id}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Field>
      <Field label={t.workspaceId} htmlFor="attach-workspace-id" hint={t.workspaceIdHint}>
        <Input id="attach-workspace-id" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} className="font-mono" />
      </Field>
      <Field label={t.cancelDirect}>
        <Select value={cancelMode} onValueChange={(v) => setCancelMode(v as 'now' | 'period_end')}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="period_end">{t.cancelPeriodEnd}</SelectItem>
            <SelectItem value="now">{t.cancelNow}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <LicenceFields value={licence} onChange={setLicence} disabled={false} appOptions={appOptions} planOptions={planOptions} idPrefix="attach" />
    </ActionDialog>
  );
}

function EditLicenceDialog({
  partnerId,
  workspace,
  appOptions,
  planOptions,
  onClose,
  onDone,
}: Readonly<{
  partnerId: string;
  workspace: AdminPartnerWorkspace;
  appOptions: AppOption[];
  planOptions: PlanOption[];
  onClose: () => void;
  onDone: () => void;
}>) {
  const t = partnersCopy().workspaces;
  const [licence, setLicence] = useState(() => (workspace.licence ? licenceFormFromSnapshot(workspace.licence) : defaultLicenceForm()));
  const parsed = parseLicenceForm(licence);

  return (
    <ActionDialog
      wide
      title={fill(t.editTitle, { name: workspace.name })}
      description={t.editHint}
      submitLabel={t.editSubmit}
      invalidMessage={parsed.ok ? null : parsed.error}
      onSubmit={(reason, requestId) =>
        updatePartnerWorkspaceLicence(
          partnerId,
          workspace.workspaceId,
          { ...licencePayload(licence), packageId: workspace.licence?.packageId ?? null, reason },
          requestId,
        )
      }
      successMessage={t.licenceSaved}
      onClose={() => {
        onClose();
        onDone();
      }}
    >
      <LicenceFields value={licence} onChange={setLicence} disabled={false} appOptions={appOptions} planOptions={planOptions} idPrefix="edit-licence" />
    </ActionDialog>
  );
}
