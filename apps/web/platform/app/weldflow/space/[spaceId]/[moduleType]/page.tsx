
import { useParams } from '@/lib/router';
import { WhiteboardView } from '@/components/weldflow/whiteboard/whiteboard-view';
import { TasksView } from '@/components/weldflow/tasks/tasks-view';
import { NotesView } from '@/components/weldflow/notes/notes-view';
import { AnalyticsView } from '@/components/weldflow/analytics/analytics-view';
import { useSpaces } from '@/contexts/spaces-context';
import { useTranslations } from '@weldsuite/i18n/client';

export default function SpaceModulePage() {
  const st = useTranslations();
  const params = useParams();
  const { spaces } = useSpaces();
  const spaceId = params.spaceId as string;
  const moduleType = params.moduleType as string;

  const space = spaces.find(s => s.id === spaceId);
  if (!space) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">{st('sweep.weldflow.spaceModule.spaceNotFound')}</p>
      </div>
    );
  }

  const module = space.modules.find(m => m.type === moduleType);
  if (!module) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">{st('sweep.weldflow.spaceModule.moduleNotFound')}</p>
      </div>
    );
  }

  // Render the appropriate component based on module type
  switch (moduleType) {
    case 'whiteboard':
      return <WhiteboardView projectId={spaceId} />;
    case 'tasks':
      return <TasksView projectId={spaceId} />;
    case 'notes':
      return <NotesView />;
    case 'pipeline':
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <h2 className="text-2xl font-semibold mb-2">{st('sweep.weldflow.spaceModule.pipeline')}</h2>
            <p className="text-muted-foreground">{st('sweep.weldflow.spaceModule.pipelineComingSoon')}</p>
          </div>
        </div>
      );
    case 'analytics':
      return <AnalyticsView />;
    case 'calendar':
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <h2 className="text-2xl font-semibold mb-2">{st('sweep.weldflow.spaceModule.calendar')}</h2>
            <p className="text-muted-foreground">{st('sweep.weldflow.spaceModule.calendarComingSoon')}</p>
          </div>
        </div>
      );
    case 'documents':
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <h2 className="text-2xl font-semibold mb-2">{st('sweep.weldflow.spaceModule.documents')}</h2>
            <p className="text-muted-foreground">{st('sweep.weldflow.spaceModule.documentsComingSoon')}</p>
          </div>
        </div>
      );
    case 'chat':
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <h2 className="text-2xl font-semibold mb-2">{st('sweep.weldflow.spaceModule.chat')}</h2>
            <p className="text-muted-foreground">{st('sweep.weldflow.spaceModule.chatComingSoon')}</p>
          </div>
        </div>
      );
    default:
      return (
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">{st('sweep.weldflow.spaceModule.unknownModuleType')}</p>
        </div>
      );
  }
}