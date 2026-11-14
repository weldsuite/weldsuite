/**
 * `FormsTab` — the Forms tab of the person panel: the WeldForms responses this
 * person gave, newest first, each opening the form's results.
 *
 * One call lists them (`weldforms.personResponses`, `GET /api/forms/responses?personId=`): the
 * responses of the forms the member may read, with each form's title (see
 * `usePersonFormResponses`).
 */

import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { usePersonFormResponses } from '@/hooks/queries/use-weldforms-results-queries';
import { FilesIllustration, TabEmptyState } from './tab-empty-state';
import { TabListRow, TabListScope } from './tab-list-row';

export function FormsTab({ personId }: Readonly<{ personId: string }>) {
  const { t, format, language } = useI18n();
  const tp = t.weldformsResults.personTab;
  const router = useRouter();
  const { rows, isLoading, error, refetch } = usePersonFormResponses(personId);
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });

  if (isLoading) return <PageLoader fullScreen={false} className="min-h-40" />;
  if (error) return <ErrorState message={tp.loadFailed} onRetry={refetch} retryLabel={t.weldformsResults.common.retry} />;
  if (rows.length === 0) {
    return <TabEmptyState illustration={<FilesIllustration />} title={tp.emptyTitle} description={tp.emptyDescription} />;
  }

  return (
    <TabListScope>
      <div className="flex items-center gap-4 border-b px-4 py-2 text-xs font-medium text-muted-foreground">
        <span className="min-w-0 flex-1">{tp.form}</span>
        <span className="hidden w-28 @md:block">{tp.submitted}</span>
        <span className="w-24">{tp.status}</span>
        <span className="hidden w-16 text-right @md:block">{tp.score}</span>
        <span className="w-[40px] flex-shrink-0" />
      </div>
      {rows.map(({ form, response }) => {
        const when = response.submittedAt ?? response.startedAt;
        return (
          <TabListRow
            key={response.id}
            label={`${form.title} · ${format(tp.responseNumber, { number: response.number ?? '' })}`}
            onOpen={() => router.push(`/weldforms/${form.id}/results?tab=responses`)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{form.title}</span>
              {response.number !== null && (
                <span className="block text-xs text-muted-foreground">{format(tp.responseNumber, { number: response.number })}</span>
              )}
            </span>
            <time dateTime={when} className="hidden w-28 text-sm tabular-nums text-muted-foreground @md:block">
              {date.format(new Date(when))}
            </time>
            <span className="w-24">
              <SoftBadge tone={response.status === 'completed' ? 'success' : 'warning'}>
                {response.status === 'completed' ? tp.completed : tp.partial}
              </SoftBadge>
            </span>
            <span className="hidden w-16 text-right text-sm tabular-nums @md:block">{response.score ?? t.weldformsResults.common.noValue}</span>
          </TabListRow>
        );
      })}
    </TabListScope>
  );
}
