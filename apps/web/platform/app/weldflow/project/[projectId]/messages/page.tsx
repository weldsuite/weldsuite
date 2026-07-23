
import { useParams } from '@/lib/router';
import { MessagesClient } from './messages-client';
import { useProjectMessages } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';

export default function ProjectMessagesPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const { data, isLoading, error } = useProjectMessages(projectId);

  if (isLoading) return <PageLoader fullScreen={false} />;

  return <MessagesClient projectId={projectId} initialMessages={data?.data || []} error={error ? String(error) : null} />;
}
