import { useMemo, useState } from 'react';
import { Navigate } from '@tanstack/react-router';
import { BookOpen, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import {
  useCreateKnowledgePage,
  useKnowledgePageTree,
  useKnowledgeSpaces,
} from '@/hooks/queries/use-knowledge-queries';
import { CreateSpaceDialog } from './components/create-space-dialog';

/**
 * WeldKnow index — the module has no home screen, so opening it lands on the
 * most recently updated page the caller can reach. Only when there is nothing
 * to open does it render: a CTA to create the first teamspace when no space
 * exists, otherwise a CTA to write the first page.
 */
export default function WeldKnowIndexPage() {
  const t = getTranslations('weldknow');
  const router = useRouter();
  const canCreate = useCan('knowledge:create');
  const { data: spacesData, isLoading: spacesLoading } = useKnowledgeSpaces();
  // `isFetching`, not `isLoading`: after a delete this route mounts while the
  // tree is being refetched, and the stale tree still lists the deleted page.
  const { data: treeData, isFetching: treeFetching } = useKnowledgePageTree();
  const createPage = useCreateKnowledgePage();
  const [showCreateSpace, setShowCreateSpace] = useState(false);

  const spaces = useMemo(() => spacesData?.data ?? [], [spacesData]);

  const latestPageId = useMemo(() => {
    const nodes = treeData?.data ?? [];
    if (nodes.length === 0) return null;
    return nodes.reduce((latest, node) =>
      new Date(node.updatedAt).getTime() > new Date(latest.updatedAt).getTime() ? node : latest,
    ).id;
  }, [treeData]);

  // The first page goes in the caller's private space, like the sidebar's
  // "New page", or else in the first teamspace they can write in.
  const firstPageSpace =
    spaces.find((s) => s.kind === 'personal' && s.canWrite) ?? spaces.find((s) => s.canWrite);

  if (treeFetching || spacesLoading) return <PageLoader fullScreen={false} />;

  if (latestPageId) {
    return <Navigate to="/weldknow/page/$pageId" params={{ pageId: latestPageId }} replace />;
  }

  if (spaces.length === 0) {
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

  const handleCreatePage = async () => {
    if (!firstPageSpace) return;
    try {
      const result = await createPage.mutateAsync({ spaceId: firstPageSpace.id, parentId: null });
      router.push(`/weldknow/page/${result.data.id}`);
    } catch {
      toast.error(t.page.createError);
    }
  };

  // There are spaces but no pages at all: the sidebar has nothing to choose
  // from, so offer to write the first page instead of "select a page".
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center px-6">
      <BookOpen className="h-10 w-10 text-muted-foreground/40" />
      <div>
        <p className="text-sm font-medium">{t.emptyState.noPagesTitle}</p>
        <p className="text-sm text-muted-foreground">{t.emptyState.noPagesDescription}</p>
      </div>
      {canCreate && firstPageSpace && (
        <Button onClick={() => void handleCreatePage()} disabled={createPage.isPending}>
          <Plus className="mr-2 h-4 w-4" />
          {t.emptyState.createPage}
        </Button>
      )}
    </div>
  );
}
