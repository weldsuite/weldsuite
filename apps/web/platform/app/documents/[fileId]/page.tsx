import { useParams } from '@/lib/router';
import { useRouter } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { ArrowLeft } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { PaginatedDocEditor } from '@/components/paginated-doc-editor/paginated-doc-editor';
import { useHtmlDoc } from '@/lib/documents/use-html-doc';
import { getTranslations } from '@/lib/i18n';

/**
 * Shared full-screen document editor — focus-mode surface reachable from any
 * inline editor's "expand" affordance and from Weld Drive. Standalone
 * paginated (A4) contenteditable; keyed by the backing file id.
 */
export default function FullScreenDocumentPage() {
  const params = useParams();
  const fileId = params.fileId as string;
  const router = useRouter();
  const { html, save } = useHtmlDoc(fileId);
  const t = getTranslations('welddrive');

  if (html === null) return <PageLoader fullScreen={false} />;

  return (
    <PaginatedDocEditor
      initialHtml={html}
      onChange={save}
      toolbarExtra={
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.history.back()}
          className="h-[30px] px-2 flex items-center gap-1.5 text-sm rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t.toolbar.back}
        </Button>
      }
    />
  );
}
