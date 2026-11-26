import { useState } from 'react';
import { CheckCircle2, Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import type { CompleteSprintResult, Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useStartSprint } from '@/hooks/queries/use-flow-agile-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { apiMessage } from '@/app/weldflow/project/[projectId]/close/_lib/api-error';
import { CompleteSprintDialog } from './complete-sprint-dialog';

/**
 * Start sprint for a planned sprint, Complete sprint for the active one (and its
 * dialog). Nothing for a sprint that is over, or for a reader.
 */
export function SprintActions({
  projectId,
  sprint,
  onCompleted,
}: Readonly<{
  projectId: string;
  sprint: Sprint;
  /** After the sprint is completed, unless the retro was opened: the board goes to the next sprint. */
  onCompleted?: (result: CompleteSprintResult) => void;
}>) {
  const { t } = useI18n();
  const copy = t.flowAgileSprints.bar;
  const { canWrite } = useProjectPermissions();
  const router = useRouter();
  const start = useStartSprint(projectId);
  const [completing, setCompleting] = useState(false);

  if (!canWrite) return null;

  const startSprint = async () => {
    try {
      await start.mutateAsync({ id: sprint.id });
      toast.success(copy.started);
    } catch (error) {
      toast.error(apiMessage(error, copy.startFailed));
    }
  };

  return (
    <>
      {sprint.status === 'planned' ? (
        <Button type="button" size="sm" disabled={start.isPending} onClick={() => void startSprint()}>
          <Play aria-hidden />
          {start.isPending ? copy.starting : copy.start}
        </Button>
      ) : null}
      {sprint.status === 'active' ? (
        <>
          <Button type="button" size="sm" onClick={() => setCompleting(true)}>
            <CheckCircle2 aria-hidden />
            {copy.complete}
          </Button>
          <CompleteSprintDialog
            projectId={projectId}
            sprint={sprint}
            open={completing}
            onOpenChange={setCompleting}
            onCompleted={(result, { openRetro }) => {
              if (openRetro) router.push(`/weldflow/project/${projectId}/sprints/${sprint.id}/retro`);
              else onCompleted?.(result);
            }}
          />
        </>
      ) : null}
    </>
  );
}
