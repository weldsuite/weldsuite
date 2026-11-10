import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { useI18n } from '@/lib/i18n/provider';
import { useFormVersions } from '@/hooks/queries/use-weldforms-queries';

interface Props {
  formId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Published versions, newest first, with who published them and how many responses each collected. */
export function VersionsDialog({ formId, open, onOpenChange }: Readonly<Props>) {
  const { t, format, language } = useI18n();
  const tv = t.weldforms.versions;
  const versions = useFormVersions(open ? formId : '');
  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tv.title}</DialogTitle>
          <DialogDescription>{tv.description}</DialogDescription>
        </DialogHeader>
        {versions.isLoading && <PageLoader fullScreen={false} />}
        {versions.error && <ErrorState message={t.weldforms.loadFailed} onRetry={() => void versions.refetch()} retryLabel={t.common.actions.retry} />}
        {versions.data && versions.data.length === 0 && <EmptyText>{tv.none}</EmptyText>}
        {versions.data && versions.data.length > 0 && (
          <ul className="divide-y rounded-md border">
            {[...versions.data]
              .sort((a, b) => b.number - a.number)
              .map((version) => (
                <li key={version.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{format(tv.version, { number: version.number })}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {dateFormat.format(new Date(version.publishedAt))} · {version.publishedBy.name ?? version.publishedBy.email ?? ''}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {format(version.responseCount === 1 ? tv.responseOne : tv.responseMany, { count: version.responseCount })}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
