import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/pipeline/[id]/page';
import { pipelineKeys } from '@/hooks/queries/use-pipelines-queries';
import { appApi } from '@/lib/api/app-api-browser-client';
import type { BreadcrumbLoaderData } from '@/lib/breadcrumbs/types';
import '@/lib/breadcrumbs/types';

interface PipelineResponse {
  data?: {
    name?: string | null;
  };
}

export const Route = createFileRoute('/weldcrm/pipeline/$id/')({
  loader: async ({ params, context }): Promise<BreadcrumbLoaderData> => {
    const data = await context.queryClient.ensureQueryData<PipelineResponse>({
      queryKey: pipelineKeys.detail(params.id),
      queryFn: () => appApi.get<PipelineResponse>(`/pipelines/${params.id}`),
      staleTime: 30_000,
    });
    return { breadcrumbLabel: data?.data?.name || 'Pipeline' };
  },
  component: PageComponent,
});
