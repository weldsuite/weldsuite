/**
 * One managed workspace: usage, the licence editor with the live "WeldSuite
 * bills / you keep" preview, status actions, extra credits and the history.
 */

import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, Building2, Coins, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  creditsToCents,
  type LicenceChangeView,
  type WorkspaceLicenceStatus,
} from '@weldsuite/app-api-client/schemas/partners';
import type { ManagedWorkspaceDetail } from '@weldsuite/app-api-client/domains/partners';
import {
  useGrantCredits,
  usePartnerCatalog,
  usePartnerOverview,
  usePartnerPackages,
  usePartnerWorkspace,
  useSetLicenceStatus,
  useSetWorkspaceLicence,
} from '@/hooks/queries/use-partner-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { usePartnerContext } from '@/lib/partner/partner-context';
import { Link, useParams } from '@/lib/router';
import {
  EmptyBlock,
  ErrorBlock,
  LicenceStatusBadge,
  LoadingBlock,
  StatCard,
  errorText,
  useFormatters,
} from '../components/kit';
import { LicenceEditor } from '../components/licence-editor';
import { LicencePreview } from '../components/licence-preview';
import { draftFromLicence, parseDraft, type LicenceDraft, type LicenceDraftErrors } from '../lib/licence-draft';

type StatusAction = 'suspend' | 'reactivate' | 'end';

const ACTION_STATUS: Record<StatusAction, WorkspaceLicenceStatus> = {
  suspend: 'suspended',
  reactivate: 'active',
  end: 'ended',
};

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `grant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function PartnerWorkspaceDetailPage() {
  const { t } = useI18n();
  const tw = t.partner.workspaceDetail;
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { data, isLoading, error, refetch } = usePartnerWorkspace(workspaceId);

  const back = (
    <Link
      href="/partner/workspaces"
      className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
      {tw.backToList}
    </Link>
  );

  if (isLoading) {
    return (
      <>
        {back}
        <LoadingBlock rows={5} />
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        {back}
        {error ? (
          <ErrorBlock message={errorText(error, t.partner.common.loadFailed)} onRetry={() => void refetch()} />
        ) : (
          <EmptyBlock icon={Building2} title={tw.notFound} description={tw.notFoundDescription} />
        )}
      </>
    );
  }

  return (
    <>
      {back}
      <WorkspaceDetail workspace={data} />
    </>
  );
}

function WorkspaceDetail({ workspace }: Readonly<{ workspace: ManagedWorkspaceDetail }>) {
  const { t, format } = useI18n();
  const tw = t.partner.workspaceDetail;
  const f = useFormatters();
  const { can } = usePartnerContext();
  const canManage = can('partner:licences:manage');
  const setStatus = useSetLicenceStatus(workspace.workspaceId);
  const [action, setAction] = useState<StatusAction | null>(null);
  const [granting, setGranting] = useState(false);

  const status = workspace.licence.status;

  const runAction = async () => {
    if (!action) return;
    try {
      await setStatus.mutateAsync({ status: ACTION_STATUS[action] });
      toast.success(tw.statusChanged);
      setAction(null);
    } catch (err) {
      toast.error(errorText(err, tw.statusFailed));
    }
  };

  const actionCopy: Record<StatusAction, { title: string; description: string; confirm: string }> = {
    suspend: { title: tw.suspendTitle, description: tw.suspendDescription, confirm: tw.suspend },
    reactivate: { title: tw.reactivateTitle, description: tw.reactivateDescription, confirm: tw.reactivate },
    end: { title: tw.endTitle, description: tw.endDescription, confirm: tw.endLicence },
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{workspace.name}</h1>
            <LicenceStatusBadge status={status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {workspace.ownerEmail ? `${tw.ownerEmail}: ${workspace.ownerEmail} · ` : ''}
            {format(tw.since, { date: f.date(workspace.licence.startsAt) })}
          </p>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {status !== 'ended' && (
              <Button variant="outline" onClick={() => setGranting(true)}>
                <Coins className="mr-1.5 h-4 w-4" aria-hidden />
                {tw.grantCredits}
              </Button>
            )}
            {status === 'active' && (
              <Button variant="outline" onClick={() => setAction('suspend')}>
                {tw.suspend}
              </Button>
            )}
            {status !== 'active' && (
              <Button variant="outline" onClick={() => setAction('reactivate')}>
                {tw.reactivate}
              </Button>
            )}
            {status !== 'ended' && (
              <Button variant="outline" className="text-destructive" onClick={() => setAction('end')}>
                {tw.endLicence}
              </Button>
            )}
          </div>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        {status === 'active' ? tw.statusActiveHint : status === 'suspended' ? tw.statusSuspendedHint : tw.statusEndedHint}
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={tw.activeMembers} value={f.number(workspace.activeMembers)} />
        <StatCard
          label={tw.creditsUsed}
          value={f.number(workspace.creditsUsedThisPeriod)}
          hint={format(t.partner.workspaces.creditsOf, {
            used: f.number(workspace.creditsUsedThisPeriod),
            allowance: f.number(workspace.licence.monthlyCredits),
          })}
        />
        <StatCard label={tw.creditBalance} value={f.number(workspace.creditBalance)} />
      </div>

      {/* Remount when the stored licence changes so the form re-syncs after a save. */}
      <LicenceCard key={JSON.stringify(workspace.licence)} workspace={workspace} canManage={canManage} />

      <HistoryCard history={workspace.history} />

      <ConfirmDialog
        open={action !== null}
        onOpenChange={(open) => !open && setAction(null)}
        title={action ? actionCopy[action].title : ''}
        description={action ? actionCopy[action].description : ''}
        confirmLabel={action ? actionCopy[action].confirm : undefined}
        cancelLabel={t.partner.common.cancel}
        variant={action === 'end' ? 'destructive' : 'default'}
        loading={setStatus.isPending}
        onConfirm={runAction}
      />

      {granting && <GrantCreditsDialog workspaceId={workspace.workspaceId} onClose={() => setGranting(false)} />}
    </div>
  );
}

function LicenceCard({ workspace, canManage }: Readonly<{ workspace: ManagedWorkspaceDetail; canManage: boolean }>) {
  const { t } = useI18n();
  const tw = t.partner.workspaceDetail;
  const overview = usePartnerOverview();
  const catalog = usePartnerCatalog();
  const packages = usePartnerPackages();
  const save = useSetWorkspaceLicence(workspace.workspaceId);

  const initial = useMemo(() => draftFromLicence(workspace.licence), [workspace.licence]);
  const [draft, setDraft] = useState<LicenceDraft>(initial);
  const [errors, setErrors] = useState<LicenceDraftErrors>({});
  const [seats, setSeats] = useState(Math.max(1, workspace.activeMembers));
  const [failure, setFailure] = useState<string | null>(null);

  const dirty = JSON.stringify({ ...draft, reason: '' }) !== JSON.stringify(initial);
  const ended = workspace.licence.status === 'ended';
  const editable = canManage && !ended;

  const onSave = async () => {
    setFailure(null);
    const parsed = parseDraft(draft);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    try {
      await save.mutateAsync(parsed.value);
      toast.success(tw.licenceSaved);
    } catch (err) {
      setFailure(errorText(err, tw.licenceFailed));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{tw.licenceCard}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <LicenceEditor
            draft={draft}
            onChange={setDraft}
            errors={errors}
            catalog={catalog.data}
            packages={packages.data}
            disabled={!editable || save.isPending}
            showReason={editable}
            idPrefix="ld"
          />
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          {editable && (
            <Button onClick={() => void onSave()} disabled={!dirty || save.isPending}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              {tw.saveLicence}
            </Button>
          )}
        </div>
        <div className="lg:sticky lg:top-24 lg:self-start">
          <LicencePreview contract={overview.data?.contract} draft={draft} seats={seats} onSeatsChange={setSeats} />
        </div>
      </CardContent>
    </Card>
  );
}

function GrantCreditsDialog({ workspaceId, onClose }: Readonly<{ workspaceId: string; onClose: () => void }>) {
  const { t, format } = useI18n();
  const tw = t.partner.workspaceDetail;
  const f = useFormatters();
  const overview = usePartnerOverview();
  const grant = useGrantCredits(workspaceId);
  // One key per opening: a double click or a retry of the same grant is
  // answered from the first, instead of granting twice.
  const keyRef = useRef(newIdempotencyKey());
  const [credits, setCredits] = useState('');
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const amount = /^\d+$/.test(credits.trim()) ? Number(credits.trim()) : 0;
  const contract = overview.data?.contract;
  const cost = contract && amount > 0 ? creditsToCents(amount, contract.extraCreditPrice) : null;

  const submit = async () => {
    if (amount < 1) return;
    setFailure(null);
    try {
      const res = await grant.mutateAsync({
        body: { credits: amount, ...(note.trim() ? { note: note.trim() } : {}) },
        idempotencyKey: keyRef.current,
      });
      toast.success(format(tw.granted, { count: f.number(res.data.amount) }));
      onClose();
    } catch (err) {
      setFailure(errorText(err, tw.grantFailed));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !grant.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tw.grantTitle}</DialogTitle>
          <DialogDescription>
            {format(tw.grantDescription, { price: contract ? f.unitPrice(contract.extraCreditPrice, contract.currency) : '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="grant-credits">{tw.grantAmount}</Label>
            <Input
              id="grant-credits"
              inputMode="numeric"
              value={credits}
              onChange={(e) => setCredits(e.target.value)}
              disabled={grant.isPending}
              autoFocus
            />
            {cost !== null && <p className="text-xs text-muted-foreground">{format(tw.grantCost, { amount: f.cents(cost) })}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="grant-note">{tw.grantNote}</Label>
            <Textarea id="grant-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={grant.isPending} />
          </div>
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={grant.isPending}>
            {t.partner.common.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={amount < 1 || grant.isPending}>
            {grant.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {tw.grantSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryCard({ history }: Readonly<{ history: LicenceChangeView[] }>) {
  const { t, format } = useI18n();
  const tw = t.partner.workspaceDetail;
  const f = useFormatters();

  const entries = [...history].sort((a, b) => b.changedAt.localeCompare(a.changedAt));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{tw.history}</CardTitle>
        <CardDescription className="sr-only">{tw.history}</CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tw.historyEmpty}</p>
        ) : (
          <ol className="space-y-4">
            {entries.map((entry) => {
              const pricing = entry.snapshot.resalePricing;
              return (
                <li key={entry.id} className="border-l-2 pl-4">
                  <p className="text-sm">
                    <span className="font-medium">{f.dateTime(entry.changedAt)}</span>{' '}
                    <span className="text-muted-foreground">
                      {format(tw.historyBy, { who: tw.historyWho[entry.changedByType] })}
                    </span>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {format(tw.historySummary, {
                      apps: entry.snapshot.allowedApps.length,
                      credits: f.number(entry.snapshot.monthlyCredits),
                      price: `${f.money(pricing.amount)}${pricing.model === 'per_seat' ? ` ${t.partner.licence.pricingPerSeat.toLowerCase()}` : ''}`,
                    })}
                    {' · '}
                    {t.partner.licenceStatus[entry.snapshot.status]}
                  </p>
                  {entry.reason && <p className="text-sm italic text-muted-foreground">“{entry.reason}”</p>}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
