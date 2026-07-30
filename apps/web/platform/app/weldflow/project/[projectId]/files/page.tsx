
import { useParams } from '@/lib/router';
import FilesComponent from './files-component';
import { useProjectFiles } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';
import type { FileResponse } from '@/lib/api/legacy-types';

export default function ProjectFilesPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const { data, isLoading } = useProjectFiles(projectId);

  if (isLoading) return <PageLoader fullScreen={false} />;

  // `FilesComponent` expects the legacy shape; it immediately re-normalizes
  // every file through its own `normalizeFile(Record<string, unknown>)`, so
  // this only needs to satisfy the type, not reproduce every field exactly.
  const initialFiles: FileResponse[] = (data?.data || []).map((f) => ({
    id: f.id,
    fileKey: f.fileKey || f.storagePath,
    fileName: f.fileName,
    contentType: f.mimeType,
    size: f.fileSize,
    folder: '',
    url: f.url || '',
    isPublic: f.isPublic,
    expiresAt: f.expiresAt || undefined,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }));

  return (
    <div className="-mt-3 md:-mt-4">
      <FilesComponent projectId={projectId} initialFiles={initialFiles} />
    </div>
  );
}
