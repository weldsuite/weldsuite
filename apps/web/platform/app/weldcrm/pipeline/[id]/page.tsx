import { useParams } from '@/lib/router';
import { ServerPipelineKanban } from '@/components/weldcrm/pipeline/server-pipeline-kanban';
import { usePipeline } from '@/hooks/queries/use-pipelines-queries';
import { PageLoader } from '@/components/page-loader';
import { useTranslations } from '@weldsuite/i18n/client';

export default function DynamicPipelinePage() {
  const params = useParams();
  const id = params.id as string;
  const t = useTranslations();

  // `isPending`, not `isLoading`: while the persisted query cache restores
  // after a reload the query has no data yet but isn't fetching, and
  // `isLoading` would flash "not found" (TASK-1085).
  const { data, isPending } = usePipeline(id);

  if (isPending) return <PageLoader fullScreen={false} label={t('crm.pipeline.loading')} />;

  if (!data?.data) {
    return <div className="flex items-center justify-center p-8">{t('crm.sidebar.pipelineNotFound')}</div>;
  }

  return (
    <ServerPipelineKanban pipelineId={id} />
  );
}
