import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import type { CreateLabelsResult } from '@weldsuite/app-api-client/schemas/shipping';
import { useCarriers, usePickListShipping } from '@/hooks/queries/use-shipping-queries';
import { getTranslations } from '@/lib/i18n';
import { LabelsForm } from './labels-form';
import { LabelsResult } from './labels-result';

interface CreateLabelsDialogProps {
  pickListId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Labels for a packed pick list: the form when it has none yet, the labels
 * (with print, void and "Mark as shipped") when it does.
 */
export function CreateLabelsDialog({ pickListId, open, onOpenChange }: Readonly<CreateLabelsDialogProps>) {
  const t = getTranslations('weldstash').shipping.labels;
  const shipping = usePickListShipping(pickListId, open);
  const carriers = useCarriers(open);
  const [created, setCreated] = useState<CreateLabelsResult | null>(null);
  // Bumped after a void so the form starts again from the server's prefill.
  const [formVersion, setFormVersion] = useState(0);

  // Voided labels stay on the record as cancelled parcels; they are not labels the list has.
  const data = shipping.data ? { ...shipping.data, parcels: shipping.data.parcels.filter((p) => p.status !== 'cancelled') } : undefined;
  const hasLabels = !!data && (created !== null || data.parcels.length > 0);
  const title = data?.orderNumber ? t.title.replace('{order}', data.orderNumber) : t.titleNoOrder;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
        </DialogHeader>
        {shipping.isLoading || carriers.isLoading ? (
          <PageLoader fullScreen={false} />
        ) : shipping.isError || carriers.isError || !data ? (
          <ErrorState
            message={((shipping.error ?? carriers.error) as Error | null)?.message || t.loadError}
            onRetry={() => {
              void shipping.refetch();
              void carriers.refetch();
            }}
          />
        ) : hasLabels ? (
          <LabelsResult
            pickListId={pickListId}
            shipping={data}
            created={created}
            onClose={() => onOpenChange(false)}
            onVoided={() => {
              setCreated(null);
              setFormVersion((v) => v + 1);
            }}
          />
        ) : (
          <LabelsForm
            key={formVersion}
            pickListId={pickListId}
            shipping={data}
            carriers={carriers.data ?? []}
            onCreated={setCreated}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
