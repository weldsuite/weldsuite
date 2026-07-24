
import { useState, useCallback, useMemo } from 'react';
import { useWidgetsList, useCreateWidget, useDeleteWidget } from '@/hooks/queries/use-helpdesk-queries';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { MessageSquare, EllipsisVertical, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityList, EmptyStateIllustration, type HeaderColumn } from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

interface Widget {
  id: string;
  widgetId: string;
  widgetName: string;
  createdAt: string;
}

interface RawWidget {
  widgetId: string;
  widgetName?: string;
  createdAt: string;
}

export default function ChatWidgetPage() {
  const { t } = useI18n();
  const tw = t.helpdesk.chatWidget;
  const { data, isLoading } = useWidgetsList();
  const createWidget = useCreateWidget();
  const deleteWidget = useDeleteWidget();
  const navigate = useNavigate();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState<string | null>(null);
  const [newWidgetName, setNewWidgetName] = useState('');

  const widgets: Widget[] = useMemo(() =>
    (data?.data ?? []).map((w: RawWidget) => ({
      id: w.widgetId,
      widgetId: w.widgetId,
      widgetName: w.widgetName || tw.unnamedWidget,
      createdAt: w.createdAt,
    })),
    [data, tw.unnamedWidget],
  );

  const handleCreate = async () => {
    try {
      const result = await createWidget.mutateAsync({ widgetName: newWidgetName || tw.newWidget });
      if (result.success && result.data?.widgetId) {
        setShowCreateDialog(false);
        setNewWidgetName('');
        toast.success(tw.widgetCreated);
        navigate({ to: '/welddesk/chat-widget/$widgetId', params: { widgetId: result.data.widgetId } });
      }
    } catch {
      toast.error(tw.failedToCreateWidget);
    }
  };

  const handleDelete = async (widgetId: string) => {
    try {
      await deleteWidget.mutateAsync(widgetId);
      setShowDeleteDialog(null);
      toast.success(tw.widgetDeleted);
    } catch {
      toast.error(tw.failedToDeleteWidget);
    }
  };

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: tw.name, width: 'min-w-[200px] flex-1' },
    { id: 'widgetId', header: tw.widgetId, width: 'w-[200px]' },
    { id: 'created', header: tw.created, width: 'w-[100px]' },
  ], [tw]);

  const renderRow = useCallback((widget: Widget) => {
    return (
      <div
        key={widget.id}
        onClick={() => navigate({ to: '/welddesk/chat-widget/$widgetId', params: { widgetId: widget.widgetId } })}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      >
        {/* Name */}
        <div className="min-w-[200px] flex-1 flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
            {widget.widgetName}
          </span>
        </div>

        {/* Widget ID */}
        <div className="w-[200px]">
          <code className="text-xs text-gray-500 dark:text-muted-foreground bg-gray-100 dark:bg-muted px-2 py-0.5 rounded">
            {widget.widgetId}
          </code>
        </div>

        {/* Created */}
        <div className="w-[100px]">
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {widget.createdAt ? new Date(widget.createdAt).toLocaleDateString() : '—'}
          </span>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          {widgets.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950" onClick={() => setShowDeleteDialog(widget.widgetId)}>
                  <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-600" />
                  {tw.delete}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  }, [navigate, widgets.length, tw.delete]);

  return (
    <>
      <EntityList<Widget>
        items={widgets}
        isLoading={isLoading}
        error={null}
        headerColumns={headerColumns}
        filters={[]}
        renderRow={renderRow}
        searchPlaceholder={tw.searchWidgets}
        searchFields={['widgetName', 'widgetId']}
        topBarClassName="pt-2 pb-2"
        stickyOffset={-16}
        createButton={{
          label: tw.newWidget,
          onClick: () => setShowCreateDialog(true),
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <MessageSquare className="h-12 w-12 text-gray-300 dark:text-muted-foreground" />
            </EmptyStateIllustration>
          ),
          title: tw.noWidgetsYet,
          description: tw.createFirstWidget,
          createLabel: tw.createWidget,
        }}
      />

      {/* Create Widget Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tw.createWidget}</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="widget-name">{tw.widgetName}</Label>
            <Input
              id="widget-name"
              placeholder={tw.widgetNamePlaceholder}
              value={newWidgetName}
              onChange={(e) => setNewWidgetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              className="mt-1.5"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>{tw.cancel}</Button>
            <Button onClick={handleCreate} disabled={createWidget.isPending}>
              {createWidget.isPending ? tw.creating : tw.createWidget}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!showDeleteDialog} onOpenChange={() => setShowDeleteDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tw.deleteWidget}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-500 dark:text-muted-foreground">
            {tw.deleteWidgetConfirm}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(null)}>{tw.cancel}</Button>
            <Button
              variant="destructive"
              onClick={() => showDeleteDialog && handleDelete(showDeleteDialog)}
              disabled={deleteWidget.isPending}
            >
              {deleteWidget.isPending ? tw.deleting : tw.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
