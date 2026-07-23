import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { FileText, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { useKnowledgeTrash, useRestoreKnowledgePage } from '@/hooks/queries/use-knowledge-queries';

export default function TrashPage() {
  const t = getTranslations('weldknow');
  const router = useRouter();
  const { data, isLoading } = useKnowledgeTrash();
  const restorePage = useRestoreKnowledgePage();

  const items = data?.data ?? [];

  const handleRestore = async (id: string) => {
    try {
      await restorePage.mutateAsync(id);
      toast.success(t.trash.restoreSuccess);
      router.push(`/weldknow/page/${id}`);
    } catch {
      toast.error(t.trash.restoreError);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center gap-2">
        <Trash2 className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">{t.trash.title}</h1>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
          <Trash2 className="mb-2 h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm font-medium">{t.trash.empty}</p>
          <p className="text-sm text-muted-foreground">{t.trash.emptyDescription}</p>
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="shrink-0 text-lg leading-none">
                  {item.icon || <FileText className="h-4 w-4 text-muted-foreground" />}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.title || t.sidebar.untitled}</p>
                  <p className="text-xs text-muted-foreground">
                    {t.trash.deletedAt.replace(
                      '{date}',
                      formatDistanceToNow(new Date(item.deletedAt), { addSuffix: true }),
                    )}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => handleRestore(item.id)}
                disabled={restorePage.isPending}
              >
                {t.trash.restore}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
