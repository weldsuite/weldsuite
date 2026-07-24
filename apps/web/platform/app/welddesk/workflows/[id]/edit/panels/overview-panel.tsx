import React from 'react';
import {
  Zap,
  AlertCircle,
  Plus,
  X,
  Bot,
  CheckCircle2,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { getActionMeta } from '../helpdesk-workflow-constants';
import { useI18n } from '@/lib/i18n/provider';
import type { HelpdeskWorkflow } from '../types';

interface OverviewPanelProps {
  workflow: HelpdeskWorkflow;
  savedAgents: Array<{ id: string; name: string; description?: string; moduleKey: string }> | undefined;
  onSelectTrigger: () => void;
  onSelectStep: (index: number) => void;
  onCloseMobile: () => void;
}

export function OverviewPanel({
  workflow,
  savedAgents,
  onSelectTrigger,
  onSelectStep,
  onCloseMobile,
}: OverviewPanelProps) {
  const { t } = useI18n();
  const op = t.helpdesk.overviewPanel;

  return (
    <>
      <div className="p-3 border-b lg:hidden flex items-center justify-between">
        <h3 className="font-semibold text-sm">{op.workflowDetails}</h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onCloseMobile}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Checklist */}
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">{op.checklist}</h3>
            <p className="text-xs text-muted-foreground">
              {op.checklistDesc}
            </p>
          </div>

          <div className="space-y-3">
            {/* Trigger check */}
            {(!workflow.triggers?.[0]?.type || !workflow.triggers?.[0]?.entityType) && (
              <Button
                variant="ghost"
                onClick={onSelectTrigger}
                className="w-full text-left p-3 rounded-lg border border-border hover:border-teal-200 transition-colors h-auto justify-start flex-col items-start"
              >
                <div className="flex items-center justify-between gap-2 w-full">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-md bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center">
                      <Zap className="w-3.5 h-3.5 text-teal-600" />
                    </div>
                    <span className="text-sm font-medium">{op.selectTrigger}</span>
                  </div>
                  <span className="px-2 py-0.5 text-xs font-medium text-muted-foreground bg-muted border border-border rounded-md">
                    {op.triggerBadge}
                  </span>
                </div>
                <div className="my-3 border-t border-border w-full" />
                <div className="flex items-center gap-1.5 text-amber-600">
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span className="text-xs">{op.triggerNeedsConfig}</span>
                </div>
              </Button>
            )}

            {/* Unconfigured steps */}
            {workflow.steps.map((step, index) => {
              const config = step.config || {};
              const isConfigured = Object.keys(config).length > 0;
              if (isConfigured) return null;

              const meta = getActionMeta(step.type);
              const Icon = meta.icon;

              return (
                <Button
                  key={step.id}
                  variant="ghost"
                  onClick={() => onSelectStep(index)}
                  className="w-full text-left p-3 rounded-lg border border-border hover:border-teal-200 transition-colors h-auto justify-start flex-col items-start"
                >
                  <div className="flex items-center justify-between gap-2 w-full">
                    <div className="flex items-center gap-2">
                      <div className={cn('w-6 h-6 rounded-md flex items-center justify-center', meta.bgColor)}>
                        <Icon className={cn('w-3.5 h-3.5', meta.color)} />
                      </div>
                      <span className="text-sm font-medium">{step.name}</span>
                    </div>
                  </div>
                  <div className="my-3 border-t border-border w-full" />
                  <div className="flex items-center gap-1.5 text-amber-600">
                    <AlertCircle className="w-3.5 h-3.5" />
                    <span className="text-xs">{op.stepNeedsConfig}</span>
                  </div>
                </Button>
              );
            })}

            {/* All configured */}
            {workflow.triggers?.[0]?.entityType &&
              workflow.steps.every((step) => Object.keys(step.config || {}).length > 0) && (
                <div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900">
                  <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                    <CheckCircle2 className="w-4 h-4" />
                    <span className="text-sm font-medium">{op.allStepsConfigured}</span>
                  </div>
                </div>
              )}
          </div>

          {/* AI Agents Quick Access */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-violet-500" />
                <h3 className="text-sm font-semibold">{op.aiAgents}</h3>
              </div>
              <Link href="/welddesk/weldagent">
                <Button variant="ghost" size="sm" className="text-xs h-7 px-2">
                  {op.manage}
                </Button>
              </Link>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              {op.aiAgentsDesc}
            </p>
            {(savedAgents || []).length > 0 ? (
              <div className="space-y-1.5">
                {(savedAgents || []).slice(0, 4).map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-2.5 p-2 rounded-lg border border-border"
                  >
                    <div className="flex-shrink-0 w-6 h-6 rounded-md bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                      <Bot className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{agent.name}</p>
                      {agent.description && (
                        <p className="text-xs text-muted-foreground truncate">{agent.description}</p>
                      )}
                    </div>
                  </div>
                ))}
                {(savedAgents || []).length > 4 && (
                  <p className="text-xs text-muted-foreground text-center pt-1">
                    +{(savedAgents || []).length - 4} more
                  </p>
                )}
              </div>
            ) : (
              <Link href="/welddesk/weldagent">
                <Button variant="outline" size="sm" className="w-full">
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {op.createFirstAgent}
                </Button>
              </Link>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Helpful Resources */}
      <div className="p-4 border-t">
        <p className="text-xs text-muted-foreground mb-3">{op.helpfulResources}</p>
        <div className="grid grid-cols-2 gap-2">
          <a
            href="#"
            className="p-3 rounded-lg border border-border hover:border-gray-300 dark:hover:border-border hover:bg-muted/50 transition-colors"
          >
            <p className="text-sm font-medium mb-1">{op.documentation}</p>
            <p className="text-xs text-muted-foreground">
              {op.documentationDesc}
            </p>
          </a>
          <Link
            href="/welddesk/weldagent"
            className="p-3 rounded-lg border border-border hover:border-gray-300 dark:hover:border-border hover:bg-muted/50 transition-colors"
          >
            <p className="text-sm font-medium mb-1">{op.aiAgentsLink}</p>
            <p className="text-xs text-muted-foreground">
              {op.aiAgentsLinkDesc}
            </p>
          </Link>
        </div>
      </div>
    </>
  );
}
