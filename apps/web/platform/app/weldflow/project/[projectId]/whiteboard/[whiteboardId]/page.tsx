import { useState, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { useParams, useRouter } from '@/lib/router';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { WhiteboardView } from '@/components/weldflow/whiteboard/whiteboard-view';
import { whiteboardApi, type WhiteboardElement } from '@/app/weldflow/lib/api-client';
import { PageLoader } from '@/components/page-loader';
import { useTranslations } from '@weldsuite/i18n/client';

export default function WhiteboardDetailPage() {
  const st = useTranslations();
  const params = useParams();
  const router = useRouter();
  const { canWrite } = useProjectPermissions();
  const projectId = params.projectId as string;
  const whiteboardId = params.whiteboardId as string;

  const [whiteboardName, setWhiteboardName] = useState(st('sweep.weldflow.whiteboardListPage.whiteboardDefaultName'));
  const [elements, setElements] = useState<WhiteboardElement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // The name being edited in the header; committed on blur / Enter.
  const [nameDraft, setNameDraft] = useState('');

  useBreadcrumbs([
    { label: st('sweep.weldflow.whiteboardListPage.projects'), href: '/weldflow' },
    { label: st('sweep.weldflow.whiteboardListPage.whiteboards'), href: `/weldflow/project/${projectId}/whiteboard` },
    { label: whiteboardName },
  ]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void whiteboardApi.getById(projectId, whiteboardId).then((result) => {
      if (cancelled) return;
      if (result.success && result.data) {
        setElements(result.data.elements ?? []);
        if (result.data.name) setWhiteboardName(result.data.name);
        setNameDraft(result.data.name ?? '');
      }
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, whiteboardId]);

  const commitName = async () => {
    const next = nameDraft.trim();
    // Empty / whitespace-only names are not allowed: snap back to the saved one.
    if (!next || next === whiteboardName) {
      setNameDraft(whiteboardName);
      return;
    }
    const result = await whiteboardApi.rename(projectId, whiteboardId, next);
    if (result.success) {
      setWhiteboardName(next);
      setNameDraft(next);
      toast.success(st('sweep.weldflow.whiteboardListPage.renamedToast'));
    } else {
      setNameDraft(whiteboardName);
      toast.error(st('sweep.weldflow.whiteboardListPage.renameFailedToast'));
    }
  };

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label={st('sweep.weldflow.whiteboardListPage.backToList')}
          title={st('sweep.weldflow.whiteboardListPage.backToList')}
          onClick={() => router.push(`/weldflow/project/${projectId}/whiteboard`)}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Input
          value={nameDraft}
          readOnly={!canWrite}
          aria-label={st('sweep.weldflow.whiteboardListPage.nameLabel')}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => void commitName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setNameDraft(whiteboardName);
              e.currentTarget.blur();
            }
          }}
          className="h-8 max-w-sm border-transparent bg-transparent px-2 text-sm font-medium shadow-none hover:border-input focus-visible:border-input"
        />
      </div>
      <div className="flex-1 overflow-hidden">
        <WhiteboardView
          key={whiteboardId}
          projectId={projectId}
          whiteboardId={whiteboardId}
          initialElements={elements}
        />
      </div>
    </div>
  );
}
