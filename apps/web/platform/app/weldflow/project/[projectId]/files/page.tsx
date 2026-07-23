
import { useParams } from '@/lib/router';
import FilesComponent from './files-component';
import { useProjectFiles } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';

export default function ProjectFilesPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const { data, isLoading } = useProjectFiles(projectId);

  if (isLoading) return <PageLoader fullScreen={false} />;

  const initialFiles = data?.data || [];
  const initialTotal = initialFiles.length;

  return (
    <div className="-mt-3 md:-mt-4">
      <FilesComponent projectId={projectId} initialFiles={initialFiles} initialTotal={initialTotal} />
    </div>
  );
}
