
import { useState } from 'react';
import { useRouter } from '@/lib/router';
import { useLists, useCreateList, useDeleteList } from '@/hooks/queries/use-lists-queries';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { Plus, Trash2, Building2 } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';

/**
 * Companies → Lists. Each list is `kind='company'`.
 */
export default function CompanyListsPage() {
  const t = useTranslations();
  const router = useRouter();
  const { data, isLoading } = useLists('company');
  const create = useCreateList();
  const del = useDeleteList();

  const [isNewOpen, setIsNewOpen] = useState(false);
  const [newName, setNewName] = useState('');

  if (isLoading) return <PageLoader fullScreen={false} />;
  const lists = data?.data ?? [];

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await create.mutateAsync({
        name: newName.trim(),
        kind: 'company',
        type: 'static',
        color: 'bg-blue-500',
        icon: 'Building2',
      });
      toast.success(t('sweep.weldcrm.companyLists.createSuccess'));
      setNewName('');
      setIsNewOpen(false);
    } catch {
      // hook already toasts
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Building2 className="h-5 w-5" /> {t('sweep.weldcrm.companyLists.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('sweep.weldcrm.companyLists.subtitle')}</p>
        </div>
        <Button onClick={() => setIsNewOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> {t('sweep.weldcrm.companyLists.newList')}
        </Button>
      </div>

      {lists.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">{t('sweep.weldcrm.companyLists.emptyState')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {lists.map((list) => (
            <Card
              key={list.id}
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => router.push(`/weldcrm/lists/${list.id}`)}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium truncate">{list.name}</h3>
                    {list.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{list.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="secondary" className="text-xs">{list.type}</Badge>
                      {typeof list.memberCount === 'number' && (
                        <Badge variant="outline" className="text-xs">{t('sweep.weldcrm.companyLists.memberCount', { count: list.memberCount })}</Badge>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (confirm(t('sweep.weldcrm.companyLists.deleteConfirm', { name: list.name }))) {
                        await del.mutateAsync(list.id);
                        toast.success(t('sweep.weldcrm.companyLists.deleteSuccess'));
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={isNewOpen} onOpenChange={setIsNewOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('sweep.weldcrm.companyLists.dialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="list-name">{t('sweep.weldcrm.companyLists.nameLabel')}</Label>
            <Input
              id="list-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('sweep.weldcrm.companyLists.namePlaceholder')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsNewOpen(false)}>{t('sweep.weldcrm.companyLists.cancel')}</Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || create.isPending}>
              {create.isPending ? t('sweep.weldcrm.companyLists.creating') : t('sweep.weldcrm.companyLists.createList')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
