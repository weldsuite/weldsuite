import { Download, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { useParcelFile, type ParcelFileAction } from '@/hooks/queries/use-shipping-queries';
import { getTranslations } from '@/lib/i18n';

interface ParcelFileButtonsProps {
  parcelId: string;
  kind: 'label' | 'customs';
  /** The label's file format; ZPL is downloaded, never opened. */
  format?: 'pdf' | 'zpl' | null;
  /** Names the buttons for a screen reader, such as "Label 1". */
  subject: string;
  fileName?: string;
}

/** Print (opens the PDF in a tab) and Download for a label or customs document. */
export function ParcelFileButtons({ parcelId, kind, format, subject, fileName }: Readonly<ParcelFileButtonsProps>) {
  const t = getTranslations('weldstash').shipping.labels;
  const file = useParcelFile();
  const isZpl = kind === 'label' && format === 'zpl';

  const run = (action: ParcelFileAction) =>
    file.mutate(
      { id: parcelId, kind, action, format, fileName },
      { onError: (err) => toast.error((err as Error).message || t.downloadFailed) },
    );

  return (
    <div className="flex items-center gap-1.5">
      {isZpl ? null : (
        <Button type="button" size="sm" variant="outline" disabled={file.isPending} onClick={() => run('open')}>
          {file.isPending && file.variables?.action === 'open' ? <InlineSpinner /> : <Printer className="size-3.5" aria-hidden="true" />}
          {t.print}
          <span className="sr-only"> {subject}</span>
        </Button>
      )}
      <Button type="button" size="sm" variant="outline" disabled={file.isPending} onClick={() => run('download')}>
        {file.isPending && file.variables?.action === 'download' ? <InlineSpinner /> : <Download className="size-3.5" aria-hidden="true" />}
        {t.download}
        <span className="sr-only"> {subject}</span>
      </Button>
    </div>
  );
}
