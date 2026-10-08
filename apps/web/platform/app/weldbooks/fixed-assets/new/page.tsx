import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { useCreateFixedAsset, useCreateFixedAssetFromBillLine } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { BookIssue, FixedAssetWriteResult } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { buildCreateInput, buildFromBillLineInput, emptyAssetForm, type AssetFormValues } from '../asset-form-model';
import { errorMessage } from '../text';
import { AssetForm } from '../components/asset-form';
import { BillLineCard } from '../components/bill-line-card';
import { useIssueText } from '../components/issue-list';

/**
 * Add a fixed asset. With `?billItemId=` (and optionally `&billId=`) the asset
 * is created from that bill line: the line supplies the name, date and cost
 * the form leaves blank.
 */
export default function NewFixedAssetPage() {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fixedAssets.form;
  const common = t.weldbooksUs.assets.common;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { billItemId?: string; billId?: string };
  const billItemId = search.billItemId || undefined;
  const { can } = usePermissions();
  const { code, isResolved, isError } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(code);
  const { today } = useWeldbooksFormat();
  const issueText = useIssueText();

  const create = useCreateFixedAsset();
  const createFromBill = useCreateFixedAssetFromBillLine();
  const [reclass, setReclass] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const initial = useMemo(() => emptyAssetForm(billItemId ? '' : today()), [billItemId, today]);

  if (!isResolved && !isError) return <PageLoader fullScreen={false} />;

  const goBack = () => void navigate({ to: '/weldbooks/fixed-assets' });

  if (!can('accounts:create')) {
    return <div className="p-6 text-sm text-muted-foreground">{common.noAccess}</div>;
  }

  const finish = (result: FixedAssetWriteResult & { source?: { reclassNeeded: boolean; reclassJournalEntryId: string | null } }) => {
    const notes: BookIssue[] = result.issues;
    if (result.source?.reclassNeeded) toast.warning(tf.fromBill.reclassNeeded);
    else if (result.source?.reclassJournalEntryId) toast.success(tf.fromBill.reclassPosted);
    toast.success(billItemId ? tf.fromBill.created : notes.length > 0 ? tf.createdWithNotes : tf.created, {
      description: notes.length > 0 ? notes.map(issueText).join(' ') : undefined,
    });
    void navigate({ to: '/weldbooks/fixed-assets/$id', params: { id: result.id } });
  };

  const submit = async (values: AssetFormValues) => {
    setSubmitError(null);
    try {
      if (billItemId) {
        finish(await createFromBill.mutateAsync(buildFromBillLineInput(values, { isUs, billItemId, reclass })));
      } else {
        finish(await create.mutateAsync(buildCreateInput(values, { isUs })));
      }
    } catch (err) {
      setSubmitError(errorMessage(err));
    }
  };

  return (
    <div className="max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label={t.weldbooksUs.assets.common.back}>
          <Link to="/weldbooks/fixed-assets">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">{billItemId ? tf.fromBill.title : tf.titleNew}</h1>
          <p className="text-sm text-muted-foreground">{tf.subtitleNew}</p>
        </div>
      </div>

      <AssetForm
        mode="create"
        initial={initial}
        isUs={isUs}
        billLine={Boolean(billItemId)}
        submitting={create.isPending || createFromBill.isPending}
        submitError={submitError}
        submitLabel={tf.create}
        onCancel={goBack}
        onSubmit={(values) => void submit(values)}
        intro={
          billItemId ? (
            <BillLineCard billItemId={billItemId} billId={search.billId || undefined} reclass={reclass} onReclassChange={setReclass} />
          ) : null
        }
      />
    </div>
  );
}
