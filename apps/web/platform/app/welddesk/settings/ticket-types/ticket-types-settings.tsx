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
  GripVertical,
  ArrowLeft,
  Bug,
  HelpCircle,
  FileText,
  Settings,
  MessageSquare,
  Shield,
  Zap,
  Star,
  AlertTriangle,
  Package,
  CreditCard,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import {
  useTicketTypes,
  useUpdateTicketType,
  useDeleteTicketType,
  type TicketTypeConfig,
} from '@/hooks/queries/use-helpdesk-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TicketTypeEditor } from './ticket-type-editor';

const ICON_MAP: Record<string, LucideIcon> = {
  bug: Bug,
  'help-circle': HelpCircle,
  'file-text': FileText,
  settings: Settings,
  'message-square': MessageSquare,
  shield: Shield,
  zap: Zap,
  star: Star,
  'alert-triangle': AlertTriangle,
  package: Package,
  'credit-card': CreditCard,
  'rotate-ccw': RotateCcw,
};

function getIcon(iconName?: string): LucideIcon {
  if (!iconName) return FileText;
  return ICON_MAP[iconName] || FileText;
}

export function TicketTypesSettings() {
  const { t } = useI18n();
  const { data: ticketTypes, isLoading } = useTicketTypes();
  const updateTicketType = useUpdateTicketType();
  const deleteTicketType = useDeleteTicketType();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingType, setEditingType] = useState<TicketTypeConfig | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const ttp = t.helpdesk.ticketTypesPage;

  useBreadcrumbs([
    { label: ttp.helpdeskBreadcrumb, href: '/welddesk' },
    { label: ttp.settingsBreadcrumb, href: '/welddesk/settings' },
    { label: ttp.breadcrumb },
  ]);

  const handleCreate = () => {
    setEditingType(null);
    setEditorOpen(true);
  };

  const handleEdit = (type: TicketTypeConfig) => {
    setEditingType(type);
    setEditorOpen(true);
  };

  const handleToggleActive = async (type: TicketTypeConfig) => {
    try {
      await updateTicketType.mutateAsync({
        id: type.id,
        isActive: !type.isActive,
      });
      toast.success((type.isActive ? t.helpdesk.ticketTypesSettings.ticketTypeDisabled : t.helpdesk.ticketTypesSettings.ticketTypeEnabled).replace('{name}', type.name));
    } catch {
      toast.error(t.helpdesk.ticketTypesSettings.failedToUpdateTicketType);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteTicketType.mutateAsync(deleteId);
      toast.success(t.helpdesk.ticketTypesSettings.ticketTypeDeleted);
      setDeleteId(null);
    } catch {
      toast.error(t.helpdesk.ticketTypesSettings.failedToDeleteTicketType);
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
            <h1 className="text-2xl font-bold tracking-tight">{ttp.title}</h1>
            <p className="text-sm text-muted-foreground">
              {ttp.description}
            </p>
          </div>
          <Button onClick={handleCreate}>
            <Plus className="h-4 w-4 mr-1.5" />
            {ttp.createType}
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
        ) : !ticketTypes || ticketTypes.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <FileText className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium mb-1">{ttp.noTicketTypesTitle}</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {ttp.noTicketTypesDesc}
              </p>
              <Button onClick={handleCreate}>
                <Plus className="h-4 w-4 mr-1.5" />
                {ttp.createFirstType}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {ticketTypes.map((type) => {
              const Icon = getIcon(type.icon);
              return (
                <Card key={type.id} className={cn(!type.isActive && 'opacity-60')}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      <div className="text-muted-foreground cursor-grab">
                        <GripVertical className="h-4 w-4" />
                      </div>
                      <div
                        className="flex items-center justify-center h-10 w-10 rounded-lg shrink-0"
                        style={{
                          backgroundColor: type.color ? `${type.color}15` : undefined,
                          color: type.color || undefined,
                        }}
                      >
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{type.name}</span>
                          {!type.isActive && (
                            <Badge variant="secondary" className="text-xs">{ttp.disabled}</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground truncate">
                          {type.description || ttp.noDescription}
                          {type.fields && type.fields.length > 0 && (
                            <span className="ml-2 text-xs">
                              ({type.fields.length !== 1 ? ttp.fieldCountPlural.replace('{count}', String(type.fields.length)) : ttp.fieldCount.replace('{count}', String(type.fields.length))})
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={type.isActive}
                          onCheckedChange={() => handleToggleActive(type)}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEdit(type)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleteId(type.id)}
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
      <TicketTypeEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editingType={editingType}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title={ttp.deleteTitle}
        description={ttp.deleteDescription}
        confirmText={ttp.deleteConfirm}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
