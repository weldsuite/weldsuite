import { useState, useEffect } from 'react';
import { useParams, useRouter } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { WhiteboardView } from '@/components/weldflow/whiteboard/whiteboard-view';
import { whiteboardApi, type WhiteboardElement } from '@/app/weldflow/lib/api-client';
import { PageLoader } from '@/components/page-loader';
import { useTranslations } from '@weldsuite/i18n/client';

export default function WhiteboardDetailPage() {
  const st = useTranslations();
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const whiteboardId = params.whiteboardId as string;

  const [whiteboardName, setWhiteboardName] = useState(st('sweep.weldflow.whiteboardListPage.whiteboardDefaultName'));
  const [elements, setElements] = useState<WhiteboardElement[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useBreadcrumbs([
    { label: st('sweep.weldflow.whiteboardListPage.projects'), href: '/weldflow' },
    { label: st('sweep.weldflow.whiteboardListPage.whiteboards'), href: `/weldflow/project/${projectId}/whiteboard` },
    { label: whiteboardName },
  ]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    whiteboardApi.getById(projectId, whiteboardId).then((result) => {
      if (cancelled) return;
      if (result.success && result.data) {
        setElements(result.data.elements ?? []);
        if (result.data.name) setWhiteboardName(result.data.name);
      }
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, whiteboardId]);

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-hidden">
        <WhiteboardView
          key={whiteboardId}
          projectId={projectId}
          whiteboardId={whiteboardId}
          initialElements={elements}
          onBack={() => router.push(`/weldflow/project/${projectId}/whiteboard`)}
        />
      </div>
    </div>
  );
}
