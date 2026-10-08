import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { useFixedAsset, useUpdateFixedAsset } from '@/hooks/queries/use-weldbooks-assets-queries';
import { useI18n } from '@/lib/i18n/provider';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { assetFormFromDetail, buildUpdateInput, type AssetFormValues } from '../../asset-form-model';
import { errorMessage } from '../../text';
import { AssetForm } from '../../components/asset-form';

/** Edit a fixed asset. Once depreciation is posted only the name, number, notes and location change. */
export default function EditFixedAssetPage() {
  const { id } = useParams({ strict: false }) as { id?: string };
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fixedAssets.form;
  const common = t.weldbooksUs.assets.common;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { code, isResolved, isError: jurisdictionError } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(code);
  const { data: asset, isLoading, isError } = useFixedAsset(id);
  const update = useUpdateFixedAsset();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const initial = useMemo(() => (asset ? assetFormFromDetail(asset) : null), [asset]);

  if (isLoading || (!isResolved && !jurisdictionError)) return <PageLoader fullScreen={false} />;
  if (isError || !asset || !initial) {
    return <div className="p-6 text-sm text-muted-foreground">{tf.notFound}</div>;
  }
  if (!can('accounts:update')) {
    return <div className="p-6 text-sm text-muted-foreground">{common.noAccess}</div>;
  }

  const disposed = asset.status === 'disposed';
  const locked = disposed || asset.ledgerRows.some((row) => row.journalEntryId !== null);
  const toDetail = () => void navigate({ to: '/weldbooks/fixed-assets/$id', params: { id: asset.id } });

  const submit = async (values: AssetFormValues) => {
    setSubmitError(null);
    const input = buildUpdateInput(values, initial, { locked, isUs });
    if (Object.keys(input).length === 0) {
      toDetail();
      return;
    }
    try {
      await update.mutateAsync({ id: asset.id, input });
      toast.success(tf.updated);
      toDetail();
    } catch (err) {
      setSubmitError(errorMessage(err));
    }
  };

  return (
    <div className="max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label={common.back}>
          <Link to="/weldbooks/fixed-assets/$id" params={{ id: asset.id }}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">{tf.titleEdit}</h1>
          <p className="text-sm text-muted-foreground">
            {asset.name} · {tf.subtitleEdit}
          </p>
        </div>
      </div>

      {locked ? (
        <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-4" data-testid="edit-locked">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="space-y-1 text-sm">
            <p className="font-medium">{disposed ? tf.disposedNotice : tf.locked.title}</p>
            {!disposed ? <p className="text-muted-foreground">{tf.locked.body}</p> : null}
          </div>
        </div>
      ) : null}

      <AssetForm
        key={asset.id}
        mode="edit"
        initial={initial}
        isUs={isUs}
        locked={locked}
        submitting={update.isPending}
        submitError={submitError}
        submitLabel={tf.saveChanges}
        onCancel={toDetail}
        onSubmit={(values) => void submit(values)}
      />
    </div>
  );
}
