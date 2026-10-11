/**
 * Licence packages: reusable templates a partner applies to a workspace.
 */

import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Loader2, Package, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
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
import { licencePackageSchema } from '@weldsuite/app-api-client/schemas/partners';
import type { PartnerLicencePackage } from '@weldsuite/app-api-client/domains/partners';
import {
  useArchivePackage,
  useCreatePackage,
  usePartnerCatalog,
  usePartnerPackages,
  useUpdatePackage,
} from '@/hooks/queries/use-partner-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { usePartnerContext } from '@/lib/partner/partner-context';
import {
  EmptyBlock,
  ErrorBlock,
  FieldMessage,
  LoadingBlock,
  PageHeader,
  errorText,
  useFormatters,
} from './components/kit';
import { LicenceEditor } from './components/licence-editor';
import {
  draftFromPackage,
  emptyDraft,
  parseDraft,
  type LicenceDraft,
  type LicenceDraftErrors,
} from './lib/licence-draft';

export default function PartnerPackagesPage() {
  const { t, format } = useI18n();
  const tp = t.partner.packages;
  const f = useFormatters();
  const { can } = usePartnerContext();
  const canManage = can('partner:licences:manage');
  const [showArchived, setShowArchived] = useState(false);
  const { data, isLoading, error, refetch } = usePartnerPackages({ archived: showArchived });
  const archive = useArchivePackage();
  const [editing, setEditing] = useState<PartnerLicencePackage | 'new' | null>(null);
  const [archiving, setArchiving] = useState<PartnerLicencePackage | null>(null);

  const onArchive = async () => {
    if (!archiving) return;
    try {
      await archive.mutateAsync(archiving.id);
      toast.success(tp.archived);
      setArchiving(null);
    } catch (err) {
      toast.error(errorText(err, tp.archiveFailed));
    }
  };

  const newButton = canManage ? (
    <Button onClick={() => setEditing('new')}>
      <Plus className="mr-1.5 h-4 w-4" aria-hidden />
      {tp.newPackage}
    </Button>
  ) : undefined;

  let body;
  if (isLoading) body = <LoadingBlock />;
  else if (error) body = <ErrorBlock message={errorText(error, t.partner.common.loadFailed)} onRetry={() => void refetch()} />;
  else if ((data ?? []).length === 0)
    body = <EmptyBlock icon={Package} title={tp.emptyTitle} description={tp.emptyDescription} action={newButton} />;
  else
    body = (
      <ul className="grid gap-4 md:grid-cols-2">
        {(data ?? []).map((pkg) => (
          <li key={pkg.id}>
            <Card className={pkg.isArchived ? 'opacity-70' : undefined}>
              <CardContent className="space-y-3 p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{pkg.name}</p>
                    {pkg.description && <p className="text-sm text-muted-foreground">{pkg.description}</p>}
                  </div>
                  {pkg.isArchived && <Badge variant="secondary">{tp.archivedBadge}</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">
                  {format(tp.summary, { apps: pkg.allowedApps.length, credits: f.number(pkg.monthlyCredits) })}
                </p>
                <p className="text-sm">
                  <span className="text-muted-foreground">{tp.defaultPrice}: </span>
                  {format(pkg.defaultResalePricing.model === 'per_seat' ? tp.pricePerSeatMonth : tp.pricePerMonth, {
                    amount: f.money(pkg.defaultResalePricing.amount),
                  })}
                </p>
                {canManage && !pkg.isArchived && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(pkg)}>
                      {t.partner.common.edit}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setArchiving(pkg)}>
                      {tp.archive}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    );

  return (
    <>
      <PageHeader title={tp.title} description={tp.description} actions={newButton} />
      <div className="mb-4 flex items-center gap-2">
        <Checkbox id="pkg-show-archived" checked={showArchived} onCheckedChange={(v) => setShowArchived(v === true)} />
        <Label htmlFor="pkg-show-archived" className="text-sm font-normal">
          {tp.showArchived}
        </Label>
      </div>
      {body}

      {editing && <PackageDialog pkg={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={tp.archiveTitle}
        description={tp.archiveDescription}
        confirmLabel={tp.archive}
        cancelLabel={t.partner.common.cancel}
        loading={archive.isPending}
        onConfirm={onArchive}
      />
    </>
  );
}

const detailsSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000),
});
type DetailsValues = z.infer<typeof detailsSchema>;

function PackageDialog({ pkg, onClose }: Readonly<{ pkg: PartnerLicencePackage | null; onClose: () => void }>) {
  const { t } = useI18n();
  const tp = t.partner.packages;
  const catalog = usePartnerCatalog();
  const create = useCreatePackage();
  const update = useUpdatePackage();
  const [draft, setDraft] = useState<LicenceDraft>(() => (pkg ? draftFromPackage(pkg) : emptyDraft()));
  const [errors, setErrors] = useState<LicenceDraftErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const form = useForm<DetailsValues>({
    resolver: zodResolver(detailsSchema),
    defaultValues: { name: pkg?.name ?? '', description: pkg?.description ?? '' },
  });

  useEffect(() => {
    form.reset({ name: pkg?.name ?? '', description: pkg?.description ?? '' });
    // Reset only when a different package is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg?.id]);

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    const licence = parseDraft(draft);
    if (!licence.ok) {
      setErrors(licence.errors);
      return;
    }
    setErrors({});
    const { resalePricing, allowedApps, monthlyCredits, creditRolloverCap, maxSeats, featurePlanId, storageGb } =
      licence.value;
    const body = licencePackageSchema.safeParse({
      name: values.name,
      description: values.description || null,
      allowedApps,
      monthlyCredits,
      creditRolloverCap,
      maxSeats,
      featurePlanId,
      storageGb,
      defaultResalePricing: resalePricing,
    });
    if (!body.success) {
      setFailure(t.partner.licence.invalid);
      return;
    }
    try {
      if (pkg) await update.mutateAsync({ packageId: pkg.id, body: body.data });
      else await create.mutateAsync(body.data);
      toast.success(tp.saved);
      onClose();
    } catch (err) {
      setFailure(errorText(err, tp.saveFailed));
    }
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{pkg ? tp.editPackage : tp.newPackage}</DialogTitle>
          <DialogDescription>{tp.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="pkg-name">{tp.name}</Label>
              <Input id="pkg-name" placeholder={tp.namePlaceholder} disabled={pending} {...form.register('name')} />
              {form.formState.errors.name && <FieldMessage>{t.partner.licence.invalidPackageName}</FieldMessage>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pkg-description">{tp.descriptionLabel}</Label>
              <Textarea
                id="pkg-description"
                rows={2}
                placeholder={tp.descriptionPlaceholder}
                disabled={pending}
                {...form.register('description')}
              />
            </div>
          </div>

          <LicenceEditor
            draft={draft}
            onChange={setDraft}
            errors={errors}
            catalog={catalog.data}
            disabled={pending}
            idPrefix="pkg"
          />

          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t.partner.common.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              {pkg ? t.partner.common.save : tp.submitCreate}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
