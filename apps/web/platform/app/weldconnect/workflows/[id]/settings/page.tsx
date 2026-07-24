
import React, { useState, useEffect, useTransition } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Switch } from '@weldsuite/ui/components/switch';
import { Loader2, GitPullRequest, History, Settings, type LucideIcon } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { Link, useParams } from '@/lib/router';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { WorkflowSettings } from '@/lib/db/schema/workflows';
import { useI18n } from '@/lib/i18n/provider';

interface WorkflowSettingsContentProps {
  workflowId: string;
  basePath?: string;
  editorHref?: string;
  replaceExecutionsTab?: { label: string; href: string; icon: LucideIcon };
  hideHeader?: boolean;
}

export function WorkflowSettingsContent({ workflowId, basePath = '/weldconnect/workflows', editorHref, replaceExecutionsTab, hideHeader }: WorkflowSettingsContentProps) {
  const { t } = useI18n();
  const { getClient } = useAppApiClient();
  const [isPending, startTransition] = useTransition();
  const [isLoading, setIsLoading] = useState(true);

  // Settings state
  const [maxCreditsPerRun, setMaxCreditsPerRun] = useState<number | undefined>(50);
  const [notifyOnError, setNotifyOnError] = useState(true);
  const [notifyOnComplete, setNotifyOnComplete] = useState(false);

  // Load workflow settings on mount
  useEffect(() => {
    async function loadWorkflow() {
      setIsLoading(true);
      try {
        const client = await getClient();
        const workflowResult = await client.get<{ data: { id: string; settings?: WorkflowSettings | null } }>(`/workflows/${workflowId}`);
        const workflow = workflowResult.data;
        if (workflow?.settings) {
          const settings = workflow.settings;
          setMaxCreditsPerRun(settings.maxCreditsPerRun ?? 50);
          setNotifyOnError(settings.notifyOnError ?? true);
          setNotifyOnComplete(settings.notifyOnComplete ?? false);
        }
      } catch (error) {
        console.error('Failed to load workflow:', error);
        toast.error(t.weldconnect.workflowSettings.toasts.loadFailed);
      } finally {
        setIsLoading(false);
      }
    }
    loadWorkflow();
  }, [workflowId, getClient, t.weldconnect.workflowSettings.toasts.loadFailed]);

  // Save settings
  const handleSave = () => {
    startTransition(async () => {
      try {
        const settings: WorkflowSettings = {
          maxCreditsPerRun,
          notifyOnError,
          notifyOnComplete,
        };

        const client = await getClient();
        await client.put<{ data: { id: string } }>(`/workflows/${workflowId}`, { settings });
        toast.success(t.weldconnect.workflowSettings.toasts.saved);
      } catch (error) {
        console.error('Failed to save settings:', error);
        toast.error(t.weldconnect.workflowSettings.toasts.saveFailed);
      }
    });
  };

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      {!hideHeader && <div className="bg-background border-b flex-shrink-0">
        <div className="px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative group">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs md:text-sm px-2 md:px-3 border-transparent bg-transparent hover:bg-accent"
                  asChild
                >
                  <Link href={editorHref ?? `${basePath}/${workflowId}/edit`}>
                    <GitPullRequest className="h-3 w-3 mr-0.5" />
                    {t.weldconnect.workflowSettings.tabEditor}
                  </Link>
                </Button>
                <div className="absolute -bottom-[9px] left-0 right-0 h-0.5 transition-colors bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600" />
              </div>
              {replaceExecutionsTab ? (
                <div className="relative group">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs md:text-sm px-2 md:px-3 border-transparent bg-transparent hover:bg-accent"
                    asChild
                  >
                    <Link href={replaceExecutionsTab.href}>
                      <replaceExecutionsTab.icon className="h-3 w-3 mr-0.5" />
                      {replaceExecutionsTab.label}
                    </Link>
                  </Button>
                  <div className="absolute -bottom-[9px] left-0 right-0 h-0.5 transition-colors bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600" />
                </div>
              ) : (
                <div className="relative group">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs md:text-sm px-2 md:px-3 border-transparent bg-transparent hover:bg-accent"
                    asChild
                  >
                    <Link href={`${basePath}/${workflowId}/edit?panel=runs`}>
                      <History className="h-3 w-3 mr-0.5" />
                      {t.weldconnect.workflowSettings.tabExecutions}
                    </Link>
                  </Button>
                  <div className="absolute -bottom-[9px] left-0 right-0 h-0.5 transition-colors bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600" />
                </div>
              )}
              <div className="relative">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs md:text-sm px-2 md:px-3 bg-muted/50 border-gray-300/70"
                >
                  <Settings className="h-3 w-3 mr-0.5" />
                  {t.weldconnect.workflowSettings.tabSettings}
                </Button>
                <div className="absolute -bottom-[9px] left-0 right-0 h-0.5 bg-foreground" />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSave}
                disabled={isPending}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                    {t.weldconnect.workflowSettings.saving}
                  </>
                ) : (
                  t.weldconnect.workflowSettings.save
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto py-12 px-4">
          {/* Quotas Section */}
          <div className="space-y-4">
            <h2 className="text-base font-semibold">{t.weldconnect.workflowSettings.quotas.title}</h2>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t.weldconnect.workflowSettings.quotas.maxCreditsLabel}</p>
                <p className="text-sm text-muted-foreground">
                  {t.weldconnect.workflowSettings.quotas.maxCreditsHint}
                </p>
              </div>
              <div className="relative">
                <Input
                  type="number"
                  min={1}
                  value={maxCreditsPerRun ?? ''}
                  onChange={(e) => setMaxCreditsPerRun(e.target.value ? parseInt(e.target.value, 10) : undefined)}
                  className="w-32 pr-16 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">
                  {t.weldconnect.workflowSettings.quotas.creditsUnit}
                </span>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t my-8" />

          {/* Notifications Section */}
          <div className="space-y-4">
            <h2 className="text-base font-semibold">{t.weldconnect.workflowSettings.notifications.title}</h2>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t.weldconnect.workflowSettings.notifications.notifyOnErrorLabel}</p>
                <p className="text-sm text-muted-foreground">
                  {t.weldconnect.workflowSettings.notifications.notifyOnErrorHint}
                </p>
              </div>
              <Switch
                checked={notifyOnError}
                onCheckedChange={setNotifyOnError}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t.weldconnect.workflowSettings.notifications.notifyOnCompleteLabel}</p>
                <p className="text-sm text-muted-foreground">
                  {t.weldconnect.workflowSettings.notifications.notifyOnCompleteHint}
                </p>
              </div>
              <Switch
                checked={notifyOnComplete}
                onCheckedChange={setNotifyOnComplete}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function WorkflowSettingsPage() {
  const params = useParams();
  const workflowId = params.id as string;

  return <WorkflowSettingsContent workflowId={workflowId} />;
}
