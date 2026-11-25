import { useParams } from '@/lib/router';
import { PipelineView } from '@/app/weldflow/project/[projectId]/pipeline/_components/pipeline-view';

/** A sprint's Board: the Pipeline for that sprint, inside the sprint page. */
export default function SprintBoardPage() {
  const params = useParams();
  return <PipelineView projectId={params.projectId as string} sprintId={params.sprintId as string} embedded />;
}
