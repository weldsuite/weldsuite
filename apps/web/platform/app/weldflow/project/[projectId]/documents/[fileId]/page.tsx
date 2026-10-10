import { useEffect, useState } from 'react';
import { useParams, useRouter } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { PaginatedDocEditor } from '@/components/paginated-doc-editor/paginated-doc-editor';
import { useHtmlDoc } from '@/lib/documents/use-html-doc';
import { documentsApi } from '@/app/weldflow/lib/api-client';
import { DocumentTitleBar } from '../document-title-bar';

export default function DocumentEditorPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const fileId = params.fileId as string;
  const { canWrite } = useProjectPermissions();
  const { html, save, status } = useHtmlDoc(fileId);
  const [name, setName] = useState('');

  useEffect(() => {
    let cancelled = false;
    void documentsApi.listDocuments(projectId).then((res) => {
      if (cancelled || !res.success || !res.data) return;
      const match = res.data.find((d) => d.id === fileId);
      if (match) setName(match.name);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, fileId]);

  if (html === null) return <PageLoader fullScreen={false} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DocumentTitleBar
        projectId={projectId}
        fileId={fileId}
        name={name}
        status={status}
        onBack={() => router.push(`/weldflow/project/${projectId}/documents`)}
      />
      <div className="min-h-0 flex-1">
        <PaginatedDocEditor initialHtml={html} editable={canWrite} onChange={save} />
      </div>
    </div>
  );
}
