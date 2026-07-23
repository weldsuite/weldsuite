
import { useEffect, useState } from 'react';
import { useParams, useRouter } from '@/lib/router';
import { analyticsApi } from '@/app/weldflow/lib/api-client';
import { PageLoader } from '@/components/page-loader';
import { useTranslations } from '@weldsuite/i18n/client';

export default function ProjectAnalyticsPage() {
  const params = useParams();
  const router = useRouter();
  const st = useTranslations();
  const projectId = params.projectId as string;
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function init() {
      try {
        // Fetch existing reports
        const reportsResult = await analyticsApi.getReports();

        if (reportsResult.success && reportsResult.data && reportsResult.data.length > 0) {
          router.replace(`/weldflow/project/${projectId}/analytics/${reportsResult.data[0].id}`);
          return;
        }

        // No reports exist, create a default one
        const createResult = await analyticsApi.createReport({
          title: st('sweep.weldflow.analytics.defaultReportTitle'),
          description: st('sweep.weldflow.analytics.defaultReportDescription'),
        });

        if (createResult.success && createResult.data) {
          router.replace(`/weldflow/project/${projectId}/analytics/${createResult.data.id}`);
          return;
        }

        // Fallback
        router.replace(`/weldflow/project/${projectId}`);
      } catch (error) {
        console.error('Failed to load analytics:', error);
        router.replace(`/weldflow/project/${projectId}`);
      } finally {
        setIsLoading(false);
      }
    }
    init();
  }, [projectId, router, st]);

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return null;
}
