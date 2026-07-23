
import { useParams } from '@/lib/router';
import { ServerPipelineKanban } from '@/components/weldcrm/pipeline/server-pipeline-kanban';
import { usePipeline } from '@/hooks/queries/use-pipelines-queries';
import { PageLoader } from '@/components/page-loader';
import { useTranslations } from '@weldsuite/i18n/client';

export default function DynamicPipelinePage() {
  const params = useParams();
  const id = params.id as string;
  const t = useTranslations();

  const { data, isLoading } = usePipeline(id);

  if (isLoading) return <PageLoader fullScreen={false} label={t('crm.pipeline.loading')} />;

  if (!data?.data) {
    return <div className="flex items-center justify-center p-8">{t('crm.pipeline.dealNotFound')}</div>;
  }

  return (
    <ServerPipelineKanban pipelineId={id} pipelineName={data.data.name} />
  );
}
