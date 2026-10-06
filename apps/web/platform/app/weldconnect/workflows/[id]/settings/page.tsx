
import React, { useState, useEffect, useId } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { AlertTriangle, Loader2, GitPullRequest, History, RotateCw, Settings, type LucideIcon } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { Link, useParams } from '@/lib/router';
import { toast } from 'sonner';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useUpdateWorkflow } from '@/hooks/queries/use-automation-queries';
import { useWorkflowDetail } from '@/hooks/use-workflow-editor-data';
import type { WorkflowSettings } from '@/lib/db/schema/workflows';
import { useI18n } from '@/lib/i18n/provider';

const NAME_MAX_LENGTH = 255;
// Mirrors workflowSettingsSchema.maxCreditsPerRun (packages/clients/app-api-client/src/schemas/weldconnect.ts).
const MAX_CREDITS_PER_RUN_MIN = 1;
const MAX_CREDITS_PER_RUN_MAX = 100_000;

interface WorkflowSettingsContentProps {
  workflowId: string;
  basePath?: string;
  editorHref?: string;
  replaceExecutionsTab?: { label: string; href: string; icon: LucideIcon };
  hideHeader?: boolean;
  /**
   * Show the workflow's name and description (WeldConnect). Hosts that name the
   * workflow elsewhere, like CRM sequences, leave this off.
   */
  showGeneral?: boolean;
}

export function WorkflowSettingsContent({ workflowId, basePath = '/weldconnect/workflows', editorHref, replaceExecutionsTab, hideHeader, showGeneral }: Readonly<WorkflowSettingsContentProps>) {
  const { t } = useI18n();
  const tws = t.weldconnect.workflowSettings;
  const nameFieldId = useId();
  const descriptionFieldId = useId();
  const maxCreditsFieldId = useId();
  const notifyOnErrorId = useId();
  const notifyOnCompleteId = useId();

  // Same cache entry the editor reads, and the same mutation the editor saves
  // through: a rename here is what the editor (and its next Save) sees.
  const { data: workflow, isLoading, isError, refetch } = useWorkflowDetail(workflowId);
  const updateWorkflow = useUpdateWorkflow();
  const isPending = updateWorkflow.isPending;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [notifyOnError, setNotifyOnError] = useState(true);
  const [notifyOnComplete, setNotifyOnComplete] = useState(false);
  const [nameError, setNameError] = useState(false);
  // Empty string = no cap. Kept as text so the field can be blank rather than
  // forced to 0 (which the API rejects anyway — 0 is not "no cap", it's invalid).
  const [maxCreditsPerRun, setMaxCreditsPerRun] = useState('');
  const [maxCreditsError, setMaxCreditsError] = useState(false);

  // Fill the form when the workflow arrives, and again only when the saved row
  // itself changed (our own save, or an edit made elsewhere), not on every
  // background refetch, which would overwrite what is being typed.
  const loadedVersion = workflow
    ? `${workflow.id}:${String((workflow as { updatedAt?: unknown }).updatedAt ?? '')}`
    : undefined;
  useEffect(() => {
    if (!workflow) return;
    const settings = (workflow as { settings?: WorkflowSettings | null }).settings;
    setName(workflow.name ?? '');
    setDescription(workflow.description ?? '');
    setNotifyOnError(settings?.notifyOnError ?? true);
    setNotifyOnComplete(settings?.notifyOnComplete ?? false);
    setMaxCreditsPerRun(
      Number.isInteger(settings?.maxCreditsPerRun) ? String(settings?.maxCreditsPerRun) : '',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedVersion]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (showGeneral && !trimmedName) {
      setNameError(true);
      toast.error(tws.general.nameRequired);
      return;
    }

    // Empty = no cap. Otherwise must be a sane positive integer (the API
    // rejects anything else — 0, negatives, fractions, or a value above the
    // max the schema allows).
    const trimmedCap = maxCreditsPerRun.trim();
    let parsedCap: number | null = null;
    if (trimmedCap) {
      const n = Number(trimmedCap);
      if (
        !Number.isInteger(n) ||
        n < MAX_CREDITS_PER_RUN_MIN ||
        n > MAX_CREDITS_PER_RUN_MAX
      ) {
        setMaxCreditsError(true);
        toast.error(tws.quotas.invalidValue);
        return;
      }
      parsedCap = n;
    }
    setMaxCreditsError(false);

    // Keep what the row holds besides the fields below.
    const { maxCreditsPerRun: _existingCap, ...keptSettings } =
      (workflow as { settings?: WorkflowSettings | null } | null | undefined)?.settings ?? {};
    try {
      await updateWorkflow.mutateAsync({
        id: workflowId,
        data: {
          ...(showGeneral ? { name: trimmedName, description: description.trim() } : {}),
          settings: {
            ...keptSettings,
            notifyOnError,
            notifyOnComplete,
            ...(parsedCap !== null ? { maxCreditsPerRun: parsedCap } : {}),
          },
        },
      });
      toast.success(tws.toasts.saved);
    } catch {
      toast.error(tws.toasts.saveFailed);
    }
  };

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (isError || !workflow) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{tws.toasts.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RotateCw className="mr-1.5 h-4 w-4" />
          {t.weldconnect.workflowEditError.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/*
       * Header. `hideHeader` callers (e.g. the WeldCRM sequence Settings tab,
       * which renders its own SequenceWizardNav above this) only want the
       * Editor/Executions/Settings tab buttons suppressed — they still need
       * the Save action, so the save button below is NOT gated on
       * `hideHeader`. Previously the whole bar (tabs AND Save) was gated
       * together, so hideHeader callers lost the only way to persist
       * changes (TASK-923).
       */}
      <div className="bg-background border-b flex-shrink-0">
        <div className="px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {!hideHeader && (
              <>
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
              </>
              )}
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
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto py-12 px-4">
          {showGeneral && (
            <>
              <div className="space-y-4">
                <h2 className="text-base font-semibold">{tws.general.title}</h2>
                <div className="space-y-2">
                  <Label htmlFor={nameFieldId}>{tws.general.nameLabel}</Label>
                  <Input
                    id={nameFieldId}
                    value={name}
                    maxLength={NAME_MAX_LENGTH}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (nameError) setNameError(false);
                    }}
                    placeholder={tws.general.namePlaceholder}
                    aria-invalid={nameError}
                    className={nameError ? 'border-destructive focus-visible:ring-destructive' : undefined}
                  />
                  {nameError && <p className="text-xs text-destructive">{tws.general.nameRequired}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor={descriptionFieldId}>{tws.general.descriptionLabel}</Label>
                  <Textarea
                    id={descriptionFieldId}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={tws.general.descriptionPlaceholder}
                    rows={3}
                  />
                </div>
              </div>

              <div className="border-t my-8" />
            </>
          )}

          {/* Notifications Section */}
          <div className="space-y-4">
            <h2 className="text-base font-semibold">{tws.notifications.title}</h2>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor={notifyOnErrorId} className="text-sm font-medium">{tws.notifications.notifyOnErrorLabel}</Label>
                <p className="text-sm text-muted-foreground">
                  {tws.notifications.notifyOnErrorHint}
                </p>
              </div>
              <Switch
                id={notifyOnErrorId}
                checked={notifyOnError}
                onCheckedChange={setNotifyOnError}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor={notifyOnCompleteId} className="text-sm font-medium">{tws.notifications.notifyOnCompleteLabel}</Label>
                <p className="text-sm text-muted-foreground">
                  {tws.notifications.notifyOnCompleteHint}
                </p>
              </div>
              <Switch
                id={notifyOnCompleteId}
                checked={notifyOnComplete}
                onCheckedChange={setNotifyOnComplete}
              />
            </div>
          </div>

          <div className="border-t my-8" />

          {/* Quotas Section */}
          <div className="space-y-4">
            <h2 className="text-base font-semibold">{tws.quotas.title}</h2>
            <div className="space-y-2">
              <Label htmlFor={maxCreditsFieldId}>{tws.quotas.maxCreditsLabel}</Label>
              <div className="flex items-center gap-2 max-w-xs">
                <Input
                  id={maxCreditsFieldId}
                  type="number"
                  inputMode="numeric"
                  min={MAX_CREDITS_PER_RUN_MIN}
                  max={MAX_CREDITS_PER_RUN_MAX}
                  step={1}
                  value={maxCreditsPerRun}
                  onChange={(e) => {
                    setMaxCreditsPerRun(e.target.value);
                    if (maxCreditsError) setMaxCreditsError(false);
                  }}
                  placeholder={tws.quotas.noLimitPlaceholder}
                  aria-invalid={maxCreditsError}
                  className={maxCreditsError ? 'border-destructive focus-visible:ring-destructive' : undefined}
                />
                <span className="text-sm text-muted-foreground">{tws.quotas.creditsUnit}</span>
              </div>
              <p className="text-sm text-muted-foreground">{tws.quotas.maxCreditsHint}</p>
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
  const { t } = useI18n();
  const crumbs = t.weldconnect.breadcrumbs;
  // Shares the content's cached query; only here to name the workflow in the trail.
  const { data: workflow } = useWorkflowDetail(workflowId);

  useBreadcrumbs([
    { label: crumbs.connect, href: '/weldconnect' },
    { label: crumbs.workflows, href: '/weldconnect/workflows' },
    ...(workflow?.name ? [{ label: workflow.name, href: `/weldconnect/workflows/${workflowId}/edit` }] : []),
    { label: crumbs.settings },
  ]);

  return <WorkflowSettingsContent workflowId={workflowId} showGeneral />;
}
