import { AlertTriangle, Info, Pencil, Plug, Trash2, Workflow } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import type { WorkflowTemplateItem } from '@weldsuite/app-api-client/schemas/weldconnect-templates';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { TemplatePreview } from './template-preview';
import { hasUnavailableParts, setupCount, stepState, triggerState, type TemplatePartState } from '../template-utils';

type TemplatesTranslations = ReturnType<typeof useI18n>['t']['weldconnect']['templates'];

function PartStateBadge({ state, tt }: Readonly<{ state: TemplatePartState; tt: TemplatesTranslations }>) {
  if (state === 'ready') return null;
  return (
    <span
      className={cn(
        'shrink-0 inline-flex items-center h-5 px-1.5 rounded text-[11px] font-medium leading-none',
        state === 'setup'
          ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400'
          : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400',
      )}
    >
      {state === 'setup' ? tt.stepNeedsSetup : tt.stepUnavailable}
    </span>
  );
}

export function categoryLabel(tt: TemplatesTranslations, category: string): string {
  return (tt.categories as Record<string, string>)[category] ?? category;
}

export function integrationLabel(tt: TemplatesTranslations, provider: string): string {
  return (tt.integrationNames as Record<string, string>)[provider] ?? provider;
}

interface TemplateDetailDialogProps {
  template: WorkflowTemplateItem | null;
  onClose: () => void;
  onUse: (template: WorkflowTemplateItem) => void;
  isUsing: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onEditDetails: (template: WorkflowTemplateItem) => void;
  onDelete: (template: WorkflowTemplateItem) => void;
}

/** A template's canvas preview next to its details and the "Use template" button. */
export function TemplateDetailDialog({
  template,
  onClose,
  onUse,
  isUsing,
  canEdit,
  canDelete,
  onEditDetails,
  onDelete,
}: Readonly<TemplateDetailDialogProps>) {
  const { t } = useI18n();
  const tt = t.weldconnect.templates;
  if (!template) return null;

  const isWorkspace = template.source === 'workspace';
  const needsSetup = setupCount(template) > 0;
  const unavailable = hasUnavailableParts(template);
  const trigger = template.triggers[0];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="overflow-hidden p-0 !max-w-[1000px] w-[1000px] max-w-[95vw] h-[700px] max-h-[90vh] !gap-0 flex">
        <div className="flex flex-1 min-h-0 min-w-0">
          <div className="hidden md:block flex-1 border-r overflow-hidden relative">
            <TemplatePreview triggers={template.triggers} steps={template.steps} />
          </div>

          <div className="w-full md:w-80 flex flex-col min-h-0">
            <div className="flex-1 overflow-y-auto p-4 pt-10">
              <div className="flex items-center gap-1.5 mb-3">
                <Badge variant="secondary" className="rounded-sm">
                  {categoryLabel(tt, template.category)}
                </Badge>
                {!isWorkspace && (
                  <Badge variant="outline" className="rounded-sm">
                    {tt.builtIn}
                  </Badge>
                )}
              </div>

              <DialogTitle className="text-lg font-semibold mb-2">{template.name}</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground mb-6">
                {template.description}
              </DialogDescription>

              {trigger && (
                <div className="mb-4">
                  <h3 className="text-sm font-medium mb-2">{tt.triggerLabel}</h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate flex-1">
                      {(t.weldconnect.triggerEmptyState as Record<string, string>)[triggerLabelKey(trigger.type)] ?? trigger.type}
                    </span>
                    <PartStateBadge state={triggerState(template)} tt={tt} />
                  </div>
                </div>
              )}

              <div className="mb-4">
                <h3 className="text-sm font-medium mb-2">{tt.stepsLabel}</h3>
                <ol className="flex flex-col gap-1.5">
                  {template.steps.map((step, index) => (
                    <li key={step.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="w-5 h-5 shrink-0 rounded-[4.5px] bg-muted flex items-center justify-center font-mono text-[10px]">
                        {index + 1}
                      </span>
                      <span className={cn('truncate flex-1', step.parentBranchId && 'pl-2')}>{step.name || step.type}</span>
                      <PartStateBadge state={stepState(template, step.id)} tt={tt} />
                    </li>
                  ))}
                </ol>
              </div>

              {template.requiredIntegrations.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-medium mb-2">{tt.connectionsLabel}</h3>
                  <div className="flex flex-col gap-1.5">
                    {template.requiredIntegrations.map((provider) => (
                      <div key={provider} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="w-5 h-5 rounded-[4.5px] bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                          <Plug className="w-3 h-3 text-blue-600 dark:text-blue-400" />
                        </span>
                        <span>{integrationLabel(tt, provider)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(needsSetup || unavailable) && (
                <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground flex gap-2">
                  {unavailable ? (
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
                  ) : (
                    <Info className="h-4 w-4 shrink-0 text-amber-500" />
                  )}
                  <p>{unavailable ? tt.unavailableHint : tt.setupHint}</p>
                </div>
              )}
            </div>

            <div className="p-4 border-t space-y-2">
              {isWorkspace && (canEdit || canDelete) && (
                <div className="flex items-center gap-2">
                  {canEdit && (
                    <>
                      <Button variant="outline" size="sm" className="flex-1" onClick={() => onEditDetails(template)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" />
                        {tt.editDetails}
                      </Button>
                      <Button variant="outline" size="sm" className="flex-1" asChild>
                        <Link href={`/weldconnect/templates/${template.id}/edit`}>
                          <Workflow className="h-3.5 w-3.5 mr-1" />
                          {tt.editSteps}
                        </Link>
                      </Button>
                    </>
                  )}
                  {canDelete && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                      onClick={() => onDelete(template)}
                      aria-label={tt.delete}
                      title={tt.delete}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              )}
              <Button className="w-full rounded-[9px]" onClick={() => onUse(template)} disabled={isUsing}>
                {isUsing ? tt.creating : tt.useTemplate}
              </Button>
              <p className="text-[11px] text-muted-foreground text-center">{tt.createdHint}</p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The trigger tile label key of `t.weldconnect.triggerEmptyState` for a trigger type. */
function triggerLabelKey(type: string): string {
  switch (type) {
    case 'entity_event':
      return 'entityEvent';
    case 'workflow_complete':
      return 'workflowComplete';
    case 'integration_event':
      return 'integrationEvent';
    default:
      return type;
  }
}
