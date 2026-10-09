import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  useDeleteSalesTaxAgency,
  useSalesTaxAgency,
  useSalesTaxSettings,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { salesTaxStateName } from '@/lib/weldbooks/us-sales-tax-states';
import { dueDayText } from '../../setup/format';
import { SalesTaxSetupGate, useSalesTaxSetupAccess } from '../../setup/setup-gate';
import { useSetupTexts } from '../../setup/setup-texts';
import { AgencyStatusBadge } from '../../setup/status-badges';
import { JurisdictionsTab } from '../../rates/jurisdictions-tab';
import { RulesTab } from '../../rules/rules-tab';
import { ZonesTab } from '../../zones/zones-tab';
import { AgencyEditDialog } from '../agency-edit-dialog';
import { AgencyStatusMenu } from '../agency-status-menu';
import { StateInfoPanel } from '../state-info-panel';

function DetailRow({ label, value }: Readonly<{ label: string; value: ReactNode }>) {
  return (
    <div className="flex justify-between gap-4 border-b py-2 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium">{value ?? '—'}</dd>
    </div>
  );
}

function AgencyDetail({ id }: Readonly<{ id: string }>) {
  const { t, format } = useSetupTexts();
  const ta = t.agency;
  const navigate = useNavigate();
  const access = useSalesTaxSetupAccess();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const agencyQuery = useSalesTaxAgency(id);
  const settings = useSalesTaxSettings();
  const remove = useDeleteSalesTaxAgency();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (agencyQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const agency = agencyQuery.data;
  const notFound = (agencyQuery.error as { status?: number } | null)?.status === 404;
  if (agencyQuery.isError || !agency) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link to="/weldbooks/sales-tax/agencies">
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
            {ta.back}
          </Link>
        </Button>
        <Alert variant={notFound ? 'default' : 'destructive'}>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{notFound ? ta.notFound : ta.loadError}</span>
            {!notFound ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void agencyQuery.refetch()}>
                {t.common.retry}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const stateName = salesTaxStateName(agency.stateCode);
  const engine = settings.data?.engine ?? 'manual';
  const tabAccess = { canCreate: access.canCreate, canUpdate: access.canUpdate, canDelete: access.canDelete };
  const countsTax = agency.status === 'registered';

  const confirmDelete = async () => {
    try {
      const result = await remove.mutateAsync(agency.id);
      if (result.deleted) {
        toast.success(ta.deleted);
        void navigate({ to: '/weldbooks/sales-tax/agencies' });
      } else {
        toast.info(ta.closedInstead);
        setDeleteOpen(false);
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t.common.saveError);
      setDeleteOpen(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="space-y-2">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link to="/weldbooks/sales-tax/agencies">
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
            {ta.back}
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">
                {stateName} ({agency.stateCode})
              </h1>
              <AgencyStatusBadge status={agency.status} />
              {agency.level === 'local' ? <Badge variant="outline">{t.agencies.localBadge}</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">{agency.name}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {access.canUpdate ? (
              <>
                <Button type="button" variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="mr-2 h-4 w-4" aria-hidden />
                  {ta.editRegistration}
                </Button>
                <AgencyStatusMenu agency={agency} />
              </>
            ) : null}
            {access.canDelete ? (
              <Button type="button" variant="outline" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                {ta.delete}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {!countsTax ? (
        <Alert role="status">
          <AlertDescription>{format(ta.notRegisteredNote, { status: t.statuses[agency.status] })}</AlertDescription>
        </Alert>
      ) : null}

      {engine !== 'manual' ? (
        <Alert role="status">
          <AlertTitle>{format(ta.notManual.title, { engine: t.engine.options[engine].name })}</AlertTitle>
          <AlertDescription>
            <p>{ta.notManual.description}</p>
            <Link to="/weldbooks/sales-tax/settings" className="text-primary underline-offset-4 hover:underline">
              {ta.notManual.link}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{ta.sections.registration}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label={ta.fields.status} value={t.statuses[agency.status]} />
              <DetailRow label={ta.fields.registrationNumber} value={agency.registrationNumber} />
              <DetailRow label={ta.fields.registeredFrom} value={formatDate(agency.registeredFrom, '—')} />
              <DetailRow label={ta.fields.registeredUntil} value={formatDate(agency.registeredUntil, '—')} />
              {agency.level === 'local' ? <DetailRow label={ta.fields.jurisdictionCode} value={agency.localJurisdictionCode} /> : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{ta.sections.filing}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label={ta.fields.frequency} value={t.frequencies[agency.filingFrequency]} />
              <DetailRow label={ta.fields.firstPeriodStart} value={formatDate(agency.firstPeriodStart, '—')} />
              <DetailRow label={ta.fields.dueDay} value={dueDayText(agency.dueDay, t.dueDay, format)} />
              <DetailRow label={ta.fields.basis} value={t.bases[agency.reportingBasis]} />
              <DetailRow label={ta.fields.sst} value={agency.sstMember ? ta.sstMember : ta.notSstMember} />
              <DetailRow
                label={ta.fields.portal}
                value={
                  agency.portalUrl ? (
                    <a
                      href={agency.portalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    >
                      {ta.openPortal}
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </a>
                  ) : null
                }
              />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{ta.sections.ledger}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow
                label={ta.fields.liability}
                value={agency.liabilityAccount ? `${agency.liabilityAccount.code} ${agency.liabilityAccount.name}` : null}
              />
              <DetailRow
                label={`${ta.fields.liability}: ${ta.fields.balance}`}
                value={agency.liabilityAccount ? formatMoney(agency.liabilityAccount.balance ?? '0') : null}
              />
              <DetailRow
                label={ta.fields.useTax}
                value={agency.useTaxAccount ? `${agency.useTaxAccount.code} ${agency.useTaxAccount.name}` : null}
              />
              <DetailRow
                label={`${ta.fields.useTax}: ${ta.fields.balance}`}
                value={agency.useTaxAccount ? formatMoney(agency.useTaxAccount.balance ?? '0') : null}
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      {agency.notes ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{ta.fields.notes}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm">{agency.notes}</p>
          </CardContent>
        </Card>
      ) : null}

      <details className="group rounded-lg border">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
          {format(ta.sections.about, { state: stateName })}
        </summary>
        <div className="border-t p-4">
          <StateInfoPanel stateCode={agency.stateCode} className="border-0 shadow-none" />
        </div>
      </details>

      <Tabs defaultValue="jurisdictions" className="gap-4">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="jurisdictions">{ta.tabs.jurisdictions}</TabsTrigger>
          <TabsTrigger value="zones">{ta.tabs.zones}</TabsTrigger>
          <TabsTrigger value="rules">{ta.tabs.rules}</TabsTrigger>
        </TabsList>
        <TabsContent value="jurisdictions">
          <JurisdictionsTab agency={agency} access={tabAccess} />
        </TabsContent>
        <TabsContent value="zones">
          <ZonesTab agency={agency} access={tabAccess} />
        </TabsContent>
        <TabsContent value="rules">
          <RulesTab agency={agency} access={tabAccess} />
        </TabsContent>
      </Tabs>

      <AgencyEditDialog agency={agency} open={editOpen} onOpenChange={setEditOpen} />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={ta.deleteDialog.title}
        description={ta.deleteDialog.description}
        confirmLabel={ta.deleteDialog.confirm}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

export default function SalesTaxAgencyDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  return (
    <SalesTaxSetupGate>
      <AgencyDetail id={id} />
    </SalesTaxSetupGate>
  );
}
