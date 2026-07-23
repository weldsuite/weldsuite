
import { useState, useRef } from 'react';
import { useWidgetById, useWidgetsList, useCreateWidget } from '@/hooks/queries/use-helpdesk-queries';
import { ChatWidgetClient, type ChatWidgetClientHandle } from './client-page';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { ChevronLeft, Plus } from 'lucide-react';
import { Link } from '@/lib/router';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';

interface WidgetEditPageProps {
  widgetId: string;
}

export default function WidgetEditPage({ widgetId }: WidgetEditPageProps) {
  const { t } = useI18n();
  const tw = t.helpdesk.chatWidget;
  const { data, isLoading } = useWidgetById(widgetId);
  const { data: widgetsListData } = useWidgetsList();
  const createWidget = useCreateWidget();
  const widgetCount = widgetsListData?.data?.length ?? 0;
  const navigate = useNavigate();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newWidgetName, setNewWidgetName] = useState('');
  const clientRef = useRef<ChatWidgetClientHandle>(null);

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

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!data?.data) {
    return (
      <div className="p-6 text-center">
        <p className="text-gray-500 dark:text-muted-foreground mb-4">{tw.widgetNotFound}</p>
        <Link href="/welddesk/chat-widget">
          <Button variant="outline">
            <ChevronLeft className="h-4 w-4 mr-2" />
            {tw.backToWidgets}
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-border bg-white dark:bg-black">
        {widgetCount > 1 && (
          <Link href="/welddesk/chat-widget">
            <Button variant="outline" size="sm" className="h-8 w-8 p-0">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Link>
        )}
        <h2 className="text-base font-medium text-gray-900 dark:text-foreground">
          {data.data.widgetName || tw.unnamedWidget}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-[1px]" />
            {tw.addWidget}
          </Button>
          <Button
            variant="ghost"
            onClick={() => clientRef.current?.save()}
            disabled={clientRef.current?.isSaving}
            className="px-3.5 py-1.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-md hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {clientRef.current?.isSaving ? tw.saving : t.helpdesk.actions.save}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <ChatWidgetClient ref={clientRef} initialSettings={data.data} widgetId={widgetId} />
      </div>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tw.createWidget}</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="widget-name">{tw.widgetName}</Label>
            <Input
              id="widget-name"
              placeholder={tw.widgetNamePlaceholder2}
              value={newWidgetName}
              onChange={(e) => setNewWidgetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !createWidget.isPending) handleCreate();
              }}
              autoFocus
              className="mt-2"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {tw.cancel}
            </Button>
            <Button onClick={handleCreate} disabled={createWidget.isPending}>
              {createWidget.isPending ? tw.creating : tw.createWidget}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
