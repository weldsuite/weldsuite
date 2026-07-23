import { useState } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Switch } from '@weldsuite/ui/components/switch';
import { Badge } from '@weldsuite/ui/components/badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  Plus,
  Pencil,
  Trash2,
  ArrowLeft,
  BookOpen,
  Globe,
  User,
  Users,
  Building2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCannedResponses,
  useUpdateCannedResponse,
  useDeleteCannedResponse,
} from '@/hooks/queries/use-helpdesk-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SavedReplyEditor } from './saved-reply-editor';

interface CannedResponseItem {
  id: string;
  name: string;
  content: string;
  category: string | null;
  scope: string;
  shortcut: string | null;
  usageCount: number | null;
  isActive: boolean;
}

const SCOPE_ICONS: Record<string, typeof Globe> = {
  global: Globe,
  team: Users,
  department: Building2,
  personal: User,
};

export function SavedRepliesSettings() {
  const { t } = useI18n();
  const srp = t.helpdesk.savedRepliesPage;
  const sre = t.helpdesk.savedReplyEditor;
  const SCOPE_LABELS: Record<string, string> = {
    global: sre.global,
    team: sre.team,
    department: sre.department,
    personal: sre.personal,
  };
  const { data: result, isLoading } = useCannedResponses();
  const updateMutation = useUpdateCannedResponse();
  const deleteMutation = useDeleteCannedResponse();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<CannedResponseItem | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useBreadcrumbs([
    { label: srp.helpdeskBreadcrumb, href: '/welddesk' },
    { label: srp.settingsBreadcrumb, href: '/welddesk/settings' },
    { label: srp.breadcrumb },
  ]);

  const items: CannedResponseItem[] = (result as any)?.data || [];

  const handleCreate = () => {
    setEditingItem(null);
    setEditorOpen(true);
  };

  const handleEdit = (item: CannedResponseItem) => {
    setEditingItem(item);
    setEditorOpen(true);
  };

  const handleToggleActive = async (item: CannedResponseItem) => {
    try {
      await updateMutation.mutateAsync({
        id: item.id,
        isActive: !item.isActive,
      });
      toast.success((item.isActive ? t.helpdesk.ticketTypesSettings.savedReplyDisabled : t.helpdesk.ticketTypesSettings.savedReplyEnabled).replace('{name}', item.name));
    } catch {
      toast.error(t.helpdesk.ticketTypesSettings.failedToUpdateSavedReply);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteMutation.mutateAsync(deleteId);
      toast.success(t.helpdesk.ticketTypesSettings.savedReplyDeleted);
      setDeleteId(null);
    } catch {
      toast.error(t.helpdesk.ticketTypesSettings.failedToDeleteSavedReply);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="container max-w-4xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild className="shrink-0">
            <Link href="/welddesk/settings">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">{srp.title}</h1>
            <p className="text-sm text-muted-foreground">
              {srp.description}
            </p>
          </div>
          <Button onClick={handleCreate}>
            <Plus className="h-4 w-4 mr-1.5" />
            {srp.createReply}
          </Button>
        </div>

        {/* List */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <Skeleton className="h-10 w-10 rounded-lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                    <Skeleton className="h-6 w-12" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <BookOpen className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium mb-1">{srp.noRepliesTitle}</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {srp.noRepliesDesc}
              </p>
              <Button onClick={handleCreate}>
                <Plus className="h-4 w-4 mr-1.5" />
                {srp.createFirstReply}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const ScopeIcon = SCOPE_ICONS[item.scope] || Globe;
              return (
                <Card key={item.id} className={cn(!item.isActive && 'opacity-60')}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      <div
                        className="flex items-center justify-center h-10 w-10 rounded-lg shrink-0 bg-muted"
                      >
                        <ScopeIcon className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{item.name}</span>
                          {item.shortcut && (
                            <Badge variant="outline" className="text-xs font-mono shrink-0">
                              /{item.shortcut}
                            </Badge>
                          )}
                          {item.category && (
                            <Badge variant="secondary" className="text-xs shrink-0">
                              {item.category}
                            </Badge>
                          )}
                          {!item.isActive && (
                            <Badge variant="secondary" className="text-xs">{srp.disabled}</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground truncate">
                          {item.content.slice(0, 100)}
                          {item.content.length > 100 ? '...' : ''}
                        </p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span>{SCOPE_LABELS[item.scope] || item.scope}</span>
                          {item.usageCount != null && item.usageCount > 0 && (
                            <span>{srp.usedTimes.replace('{count}', String(item.usageCount))}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={item.isActive}
                          onCheckedChange={() => handleToggleActive(item)}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEdit(item)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleteId(item.id)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Editor Dialog */}
      <SavedReplyEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editingItem={editingItem}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title={srp.deleteTitle}
        description={srp.deleteDescription}
        confirmText={srp.deleteConfirm}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
