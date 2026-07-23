import { useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { PaginatedDocEditor } from '@/components/paginated-doc-editor/paginated-doc-editor';
import { useHtmlDoc } from '@/lib/documents/use-html-doc';

export default function DocumentEditorPage() {
  const params = useParams();
  const fileId = params.fileId as string;
  const { canWrite } = useProjectPermissions();
  const { html, save } = useHtmlDoc(fileId);

  if (html === null) return <PageLoader fullScreen={false} />;

  return <PaginatedDocEditor initialHtml={html} editable={canWrite} onChange={save} />;
}
