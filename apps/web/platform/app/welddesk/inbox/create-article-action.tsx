import { toast } from 'sonner';
import { FilePlus2, Loader2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { useCreateDraftArticle } from '@/hooks/queries/use-desk-knowledge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';

/**
 * "Create article" in the conversation header: drafts a help article from the
 * customer's question and the team's public answers, then opens the editor.
 */
export function CreateArticleAction({ conversationId }: Readonly<{ conversationId: string }>) {
  const { t } = useI18n();
  const k = t.helpdesk.knowledgeInbox;
  const router = useRouter();
  const canCreate = useCan('articles:create');
  const draft = useCreateDraftArticle();

  if (!canCreate) return null;

  const create = async () => {
    try {
      const article = await draft.mutateAsync(conversationId);
      toast.success(k.articleCreated);
      router.push(`/welddesk/help-center/articles/${article.id}/edit`);
    } catch {
      toast.error(k.createArticleFailed);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="hidden md:flex h-8 px-2 text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary"
      onClick={() => void create()}
      disabled={draft.isPending}
      title={k.createArticleHint}
      data-testid="desk-inbox-create-article"
    >
      {draft.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePlus2 className="h-4 w-4" />}
      <span className="hidden lg:inline ml-1.5">{k.createArticle}</span>
    </Button>
  );
}
