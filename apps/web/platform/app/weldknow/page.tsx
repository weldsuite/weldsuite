import { useMemo, useState } from 'react';
import { BookOpen, FileText, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { useKnowledgePageTree, useKnowledgeSpaces } from '@/hooks/queries/use-knowledge-queries';
import { CreateSpaceDialog } from './components/create-space-dialog';

/**
 * WeldKnow index — no page selected yet. Shows a CTA to create the first
 * space when none exist, otherwise a "select or create a page" panel
 * listing recently updated pages across all accessible spaces.
 */
export default function WeldKnowIndexPage() {
  const t = getTranslations('weldknow');
  const router = useRouter();
  const canCreate = useCan('knowledge:create');
  const { data: spacesData, isLoading: spacesLoading } = useKnowledgeSpaces();
  const { data: treeData } = useKnowledgePageTree();
  const [showCreateSpace, setShowCreateSpace] = useState(false);

  const spaces = spacesData?.data ?? [];
  const recentPages = useMemo(() => {
    const nodes = treeData?.data ?? [];
    return [...nodes]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 8);
  }, [treeData]);

  if (!spacesLoading && spaces.length === 0) {
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
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-8 text-center">
        <BookOpen className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
        <h1 className="text-lg font-semibold">{t.emptyState.selectPageTitle}</h1>
        <p className="text-sm text-muted-foreground">{t.emptyState.selectPageDescription}</p>
      </div>

      {recentPages.length > 0 && (
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t.emptyState.recentlyUpdated}
          </h2>
          <div className="space-y-1">
            {recentPages.map((node) => (
              <button
                key={node.id}
                type="button"
                onClick={() => router.push(`/weldknow/page/${node.id}`)}
                className="flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/60"
              >
                <span className="shrink-0 text-base leading-none">
                  {node.icon || <FileText className="h-4 w-4 text-muted-foreground" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{node.title || t.sidebar.untitled}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
