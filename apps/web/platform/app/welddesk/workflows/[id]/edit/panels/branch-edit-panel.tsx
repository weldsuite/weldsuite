import React from 'react';
import {
  GitBranch,
  Plus,
  X,
  CheckCircle2,
  ArrowUpRight,
  XCircle,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Label } from '@weldsuite/ui/components/label';
import { cn } from '@/lib/utils';
import { getActionMeta } from '../helpdesk-workflow-constants';
import { useI18n } from '@/lib/i18n/provider';
import type { HelpdeskWorkflow } from '../types';

interface BranchEditPanelProps {
  editingBranch: {
    branchNodeId: string;
    branchType: string;
    parentConditionId: string;
    parentConditionStepIndex: number;
  };
  workflow: HelpdeskWorkflow;
  onSelectStep: (index: number) => void;
  onAddStepToBranch: (branchNodeId: string) => void;
  onClose: () => void;
}

export function BranchEditPanel({
  editingBranch,
  workflow,
  onSelectStep,
  onAddStepToBranch,
  onClose,
}: BranchEditPanelProps) {
  const { t } = useI18n();
  const bep = t.helpdesk.branchEditPanel;

  const parentStep = workflow.steps[editingBranch.parentConditionStepIndex];
  const branchChildren = workflow.steps.filter((s) => s.parentBranchId === editingBranch.branchNodeId);
  const conditionExpression = parentStep?.config?.field
    ? `${parentStep.config.field as string} ${(parentStep.config.operator as string) || ''} ${(parentStep.config.value as string) || ''}`
    : (parentStep?.config?.expression as string) || '';

  // Branch display styling
  const branchStyleMap: Record<string, { bg: string; icon: React.ElementType; iconColor: string; label: string; borderColor: string; description: string }> = {
    if: { bg: 'bg-green-100 dark:bg-green-900/30', icon: CheckCircle2, iconColor: 'text-green-600', label: bep.ifTrueLabel, borderColor: 'border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900', description: bep.ifTrueDesc },
    if_not: { bg: 'bg-gray-100 dark:bg-secondary', icon: X, iconColor: 'text-gray-500 dark:text-muted-foreground', label: bep.ifFalseLabel, borderColor: 'border-gray-200 bg-gray-50 dark:bg-background/20 dark:border-border', description: bep.ifFalseDesc },
    escalated: { bg: 'bg-amber-100 dark:bg-amber-900/30', icon: ArrowUpRight, iconColor: 'text-amber-600', label: bep.escalatedLabel, borderColor: 'border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900', description: bep.escalatedDesc },
    completed: { bg: 'bg-green-100 dark:bg-green-900/30', icon: CheckCircle2, iconColor: 'text-green-600', label: bep.completedLabel, borderColor: 'border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900', description: bep.completedDesc },
    failed: { bg: 'bg-red-100 dark:bg-red-900/30', icon: XCircle, iconColor: 'text-red-600', label: bep.failedLabel, borderColor: 'border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900', description: bep.failedDesc },
  };
  const defaultBranchStyle = { bg: 'bg-gray-100 dark:bg-secondary', icon: GitBranch, iconColor: 'text-gray-500', label: editingBranch.branchType, borderColor: 'border-gray-200 bg-gray-50 dark:bg-background/20 dark:border-border', description: bep.defaultDesc.replace('{type}', editingBranch.branchType) };
  const branchStyle = branchStyleMap[editingBranch.branchType] || defaultBranchStyle;
  const BranchIcon = branchStyle.icon;

  return (
    <>
      <div className="p-3 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn('p-1.5 rounded-md', branchStyle.bg)}>
              <BranchIcon className={cn('h-4 w-4', branchStyle.iconColor)} />
            </div>
            <h3 className="font-semibold text-sm">{branchStyle.label}</h3>
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
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{bep.parentConditionLabel}</Label>
            <Button
              variant="ghost"
              onClick={() => onSelectStep(editingBranch.parentConditionStepIndex)}
              className="w-full text-left p-3 rounded-lg border border-border hover:border-amber-200 transition-colors h-auto justify-start flex-col items-start"
            >
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                  <GitBranch className="w-3.5 h-3.5 text-amber-600" />
                </div>
                <span className="text-sm font-medium">{parentStep?.name || 'Condition'}</span>
              </div>
              {conditionExpression && (
                <p className="text-xs text-muted-foreground mt-2 truncate">{conditionExpression}</p>
              )}
            </Button>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{bep.branchLabel}</Label>
            <div className={cn('p-3 rounded-lg border', branchStyle.borderColor)}>
              <p className="text-sm font-medium">{branchStyle.description}</p>
            </div>
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-3">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {bep.stepsLabel} ({branchChildren.length})
              </Label>
            </div>

            {branchChildren.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground mb-3">{bep.noSteps}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onAddStepToBranch(editingBranch.branchNodeId)}
                >
                  <Plus className="h-4 w-4 mr-0.5" />
                  {bep.addStep}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {branchChildren.map((childStep) => {
                  const meta = getActionMeta(childStep.type);
                  const Icon = meta.icon;
                  const stepIndex = workflow.steps.findIndex((s) => s.id === childStep.id);
                  return (
                    <Button
                      key={childStep.id}
                      variant="ghost"
                      onClick={() => onSelectStep(stepIndex)}
                      className="w-full text-left p-3 rounded-lg border border-border hover:border-teal-200 transition-colors h-auto justify-start"
                    >
                      <div className="flex items-center gap-2">
                        <div className={cn('w-6 h-6 rounded-md flex items-center justify-center', meta.bgColor)}>
                          <Icon className={cn('w-3.5 h-3.5', meta.color)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{childStep.name}</p>
                        </div>
                      </div>
                    </Button>
                  );
                })}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mt-2"
                  onClick={() => onAddStepToBranch(editingBranch.branchNodeId)}
                >
                  <Plus className="h-4 w-4 mr-0.5" />
                  {bep.addStep}
                </Button>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
