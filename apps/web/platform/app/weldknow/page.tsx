import { useMemo, useState } from 'react';
import { Navigate } from '@tanstack/react-router';
import { BookOpen, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { PageLoader } from '@/components/page-loader';
import { useKnowledgePageTree, useKnowledgeSpaces } from '@/hooks/queries/use-knowledge-queries';
import { CreateSpaceDialog } from './components/create-space-dialog';

/**
 * WeldKnow index — the module has no home screen, so opening it lands on the
 * most recently updated page the caller can reach. Only when there is nothing
 * to open does it render: a CTA to create the first teamspace when no space
 * exists, otherwise a "select or create a page" hint.
 */
export default function WeldKnowIndexPage() {
  const t = getTranslations('weldknow');
  const canCreate = useCan('knowledge:create');
  const { data: spacesData, isLoading: spacesLoading } = useKnowledgeSpaces();
  // `isFetching`, not `isLoading`: after a delete this route mounts while the
  // tree is being refetched, and the stale tree still lists the deleted page.
  const { data: treeData, isFetching: treeFetching } = useKnowledgePageTree();
  const [showCreateSpace, setShowCreateSpace] = useState(false);

  const latestPageId = useMemo(() => {
    const nodes = treeData?.data ?? [];
    if (nodes.length === 0) return null;
    return nodes.reduce((latest, node) =>
      new Date(node.updatedAt).getTime() > new Date(latest.updatedAt).getTime() ? node : latest,
    ).id;
  }, [treeData]);

  if (treeFetching || spacesLoading) return <PageLoader fullScreen={false} />;

  if (latestPageId) {
    return <Navigate to="/weldknow/page/$pageId" params={{ pageId: latestPageId }} replace />;
  }

  if ((spacesData?.data ?? []).length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center px-6">
        <BookOpen className="h-10 w-10 text-muted-foreground/40" />
        <div>
          <p className="text-sm font-medium">{t.emptyState.noAccessTitle}</p>
          <p className="text-sm text-muted-foreground">{t.emptyState.noAccessDescription}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setShowCreateSpace(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t.sidebar.createSpace}
          </Button>
        )}
        <CreateSpaceDialog open={showCreateSpace} onOpenChange={setShowCreateSpace} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center px-6">
      <BookOpen className="h-10 w-10 text-muted-foreground/40" />
      <div>
        <p className="text-sm font-medium">{t.emptyState.selectPageTitle}</p>
        <p className="text-sm text-muted-foreground">{t.emptyState.selectPageDescription}</p>
      </div>
    </div>
  );
}
