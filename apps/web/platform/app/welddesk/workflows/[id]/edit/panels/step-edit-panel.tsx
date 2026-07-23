import React from 'react';
import { Trash2, AlertCircle, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Label } from '@weldsuite/ui/components/label';
import { cn } from '@/lib/utils';
import { ActionConfigForm } from '@/components/workflow-editor/components/action-config-form';
import { getActionMeta, getStepWarningMessage, getHelpdeskVariableGroups } from '../helpdesk-workflow-constants';
import { useI18n } from '@/lib/i18n/provider';

interface StepEditPanelProps {
  editingStep: any;
  workflow: any;
  workspaceMembers: Array<{ id: string; name: string; email: string; avatar?: string }>;
  workflowVariables: Array<{ name: string; type?: string }>;
  onUpdateStep: (stepId: string, data: any) => void;
  onDeleteStep: (index: number) => void;
  onClose: () => void;
}

export function StepEditPanel({
  editingStep,
  workflow,
  workspaceMembers,
  workflowVariables,
  onUpdateStep,
  onDeleteStep,
  onClose,
}: StepEditPanelProps) {
  const { t } = useI18n();
  const sep = t.helpdesk.stepEditPanel;
  const wc = t.helpdesk.workflowConstants;
  const helpdeskVariableGroups = React.useMemo(() => getHelpdeskVariableGroups(wc), [wc]);

  return (
    <>
      <div className="p-3 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {(() => {
              const meta = getActionMeta(editingStep.type);
              const Icon = meta.icon;
              return (
                <div className={cn('p-1.5 rounded-md', meta.bgColor)}>
                  <Icon className={cn('h-4 w-4', meta.color)} />
                </div>
              );
            })()}
            <h3 className="font-semibold text-sm">{sep.title}</h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {(() => {
        const warning = getStepWarningMessage(editingStep);
        if (!warning) return null;
        return (
          <div className="mx-3 mt-3 p-2.5 rounded-lg bg-amber-50 dark:bg-muted border border-amber-200 dark:border-border">
            <div className="flex items-center gap-2 text-amber-700 dark:text-muted-foreground">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="text-xs">{warning}</span>
            </div>
          </div>
        );
      })()}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          <div className="space-y-2">
            <Label className="text-xs font-medium">{sep.actionNameLabel}</Label>
            <Input
              value={editingStep.name}
              onChange={(e) => {
                const newName = e.target.value;
                onUpdateStep(editingStep.id, { name: newName });
              }}
              placeholder={sep.actionNamePlaceholder}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium">{sep.descriptionLabel}</Label>
            <Textarea
              value={editingStep.description || ''}
              onChange={(e) => {
                const newDescription = e.target.value;
                onUpdateStep(editingStep.id, { description: newDescription });
              }}
              placeholder={sep.descriptionPlaceholder}
              rows={3}
            />
          </div>

          <div className="border-t pt-4">
            <h4 className="text-xs font-medium mb-3 text-muted-foreground uppercase tracking-wide">{sep.settingsSection}</h4>
            <ActionConfigForm
              actionType={editingStep.type}
              config={editingStep.config || {}}
              onChange={(config) => {
                // Clear legacy `inputs` so stale values don't override the new config at execution time
                onUpdateStep(editingStep.id, { config, inputs: {} });
              }}
              workspaceMembers={workspaceMembers}
              workflowSteps={workflow.steps.map((s: any) => ({
                id: s.id,
                name: s.name,
                type: s.type,
              }))}
              currentStepIndex={workflow.steps.findIndex((s: any) => s.id === editingStep.id)}
              workflowVariables={workflowVariables}
              triggerType={workflow.triggers?.[0]?.type}
              extraVariableGroups={helpdeskVariableGroups}
            />
          </div>
        </div>
      </ScrollArea>
      <div className="p-3">
        <Button
          variant="outline"
          className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => {
            const stepIndex = workflow.steps.findIndex((s: any) => s.id === editingStep.id);
            if (stepIndex !== -1) {
              onDeleteStep(stepIndex);
            }
          }}
        >
          <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
          {sep.deleteStep}
        </Button>
      </div>
    </>
  );
}
