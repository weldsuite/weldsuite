
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import {
  ChevronLeft,
  GitPullRequest,
  Bot,
  History,
  Settings,
  X,
  XCircle,
  CheckCircle2,
  RefreshCw,
  Clock,
} from 'lucide-react';
import { Link } from '@/lib/router';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useUpdateWorkflow, useUpdateWorkflowStatus } from '@/hooks/queries/use-automation-queries';
import { ConversationFlowBuilder } from './components/conversation-flow-builder';
import { buildAllVariables } from '@weldsuite/ui/components/workflow-canvas/parts/variable-picker';
import { getConditionBranchIds } from '@weldsuite/ui/components/workflow-canvas';
import { cn } from '@/lib/utils';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

import {
  getHelpdeskVariableGroups,
  getHelpdeskActionTypes,
  isTerminalAction,
} from './helpdesk-workflow-constants';

import { AddActionPanel } from './panels/add-action-panel';
import { TriggerFilterPanel, type TriggerConfigUpdate } from './panels/trigger-panel';
import { BranchEditPanel } from './panels/branch-edit-panel';
import { StepEditPanel } from './panels/step-edit-panel';
import { OverviewPanel } from './panels/overview-panel';
import { SubAgentPickerDialog } from './dialogs/sub-agent-picker-dialog';
import { SubAgentEditDialog } from './dialogs/sub-agent-edit-dialog';
import type { SubAgentFormState } from './dialogs/sub-agent-edit-dialog';
import type { HelpdeskWorkflow, WorkflowStep } from './types';

// ============================================================================
// Types
// ============================================================================

interface HelpdeskWorkflowEditorProps {
  workflow: HelpdeskWorkflow;
  workspaceMembers?: Array<{ id: string; name: string; email: string; avatar?: string }>;
  workflowVariables?: Array<{ name: string; type?: string }>;
}

/** Shape of a (currently unreachable) raw agent-definition record — AI was
 * removed platform-wide, but this documents what the editor form expects if
 * the `/ai/agent-definitions` endpoint ever comes back. */
interface AgentDefinitionDetail {
  name?: string;
  description?: string;
  systemPrompt?: string;
  modelId?: string;
  temperature?: string;
  maxTokens?: number;
  maxIterations?: number;
  maxTotalTokens?: number;
  enabledBuiltinTools?: string[];
  integrationIds?: string[];
  integrationToolPermissions?: Record<string, string[]>;
  escalationRules?: { escalateOnFailure?: boolean; escalateOnMaxIterations?: boolean };
}

// ============================================================================
// Component
// ============================================================================

export function HelpdeskWorkflowEditorClient({
  workflow: initialWorkflow,
  workspaceMembers = [],
  workflowVariables = [],
}: HelpdeskWorkflowEditorProps) {
  const { t } = useI18n();
  const wc = t.helpdesk.workflowConstants;
  const tw = t.helpdesk.workflowsPage;
  const helpdeskActionTypes = useMemo(() => getHelpdeskActionTypes(wc), [wc]);
  const helpdeskVariableGroups = useMemo(() => getHelpdeskVariableGroups(wc), [wc]);

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tw.entityLabelPlural, href: '/welddesk/workflows' },
    { label: initialWorkflow.name },
  ]);

  // Build variable list for canvas inline autocomplete
  const canvasVariableItems = useMemo(
    () => buildAllVariables({
      triggerType: initialWorkflow.triggers?.[0]?.type,
      workflowVariables,
      extraVariableGroups: helpdeskVariableGroups,
    }),
    [initialWorkflow.triggers, workflowVariables, helpdeskVariableGroups]
  );

  // Workflow state
  const [workflow, setWorkflow] = useState<HelpdeskWorkflow>({
    ...initialWorkflow,
    triggers: initialWorkflow.triggers || [],
    steps: initialWorkflow.steps || [],
  });

  const updateWorkflowMutation = useUpdateWorkflow('/helpdesk-workflows');
  const updateStatusMutation = useUpdateWorkflowStatus('/helpdesk-workflows');
  const isSaving = updateWorkflowMutation.isPending || updateStatusMutation.isPending;

  // Editing state
  const [editingStep, setEditingStep] = useState<WorkflowStep | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);
  const [showAddActionPanel, setShowAddActionPanel] = useState(false);
  const [showTriggerFilterPanel, setShowTriggerFilterPanel] = useState(false);
  const [addStepSourceNodeId, setAddStepSourceNodeId] = useState<string | null>(null);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [showRunsPanel, setShowRunsPanel] = useState(false);

  // Branch editing state
  const [editingBranch, setEditingBranch] = useState<{
    branchNodeId: string;
    branchType: string;
    parentConditionId: string;
    parentConditionStepIndex: number;
  } | null>(null);

  // Sub-agent state
  const [addSubAgentForStepId, setAddSubAgentForStepId] = useState<string | null>(null);
  const [editSubAgentId, setEditSubAgentId] = useState<string | null>(null);
  const { getClient } = useAppApiClient();

  // AI (and ai_agent_definitions) was removed platform-wide (2026-07-08). The
  // `ai_agent` step type can no longer be added or configured — its config
  // form already renders the shared "AI unavailable" state (see
  // action-config-form.tsx). These sub-agent queries stay wired for any
  // pre-existing steps that still reference the add/edit sub-agent dialogs,
  // but no longer hit the removed `/ai/agent-definitions` endpoint.
  const { data: savedAgents } = useQuery({
    queryKey: ['ai-agents', 'helpdesk'],
    queryFn: async (): Promise<Array<{ id: string; name: string; description?: string; moduleKey: string }>> => [],
    staleTime: Infinity,
  });

  const { data: editSubAgentData } = useQuery({
    queryKey: ['ai-agent-detail', editSubAgentId],
    queryFn: async (): Promise<AgentDefinitionDetail | undefined> => undefined,
    enabled: false,
  });

  // Fetch MCP integration connections for sub-agent editing
  const { data: mcpConnections } = useQuery({
    queryKey: ['integration-connections-mcp'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: Array<{
        id: string;
        name: string;
        provider: string;
        status: string;
        settings: {
          discoveredTools?: Array<{ name: string; description: string }>;
          [key: string]: unknown;
        };
      }> }>('/integrations/connections');
      return (res.data || []).filter((c) => c.provider === 'mcp_server' && c.status === 'active');
    },
  });

  const [subAgentForm, setSubAgentForm] = useState<SubAgentFormState | null>(null);

  // Populate form when agent data loads
  useEffect(() => {
    if (editSubAgentData && editSubAgentId) {
      setSubAgentForm({
        name: editSubAgentData.name || '',
        description: editSubAgentData.description || '',
        systemPrompt: editSubAgentData.systemPrompt || '',
        modelId: editSubAgentData.modelId || 'openai/gpt-4o',
        temperature: parseFloat(editSubAgentData.temperature || '') || 0.7,
        maxTokens: editSubAgentData.maxTokens || 1024,
        maxIterations: editSubAgentData.maxIterations || 10,
        maxTotalTokens: editSubAgentData.maxTotalTokens || 20000,
        enabledBuiltinTools: editSubAgentData.enabledBuiltinTools || [],
        integrationIds: editSubAgentData.integrationIds || [],
        integrationToolPermissions: editSubAgentData.integrationToolPermissions || {},
        escalationRules: {
          escalateOnFailure: editSubAgentData.escalationRules?.escalateOnFailure !== false,
          escalateOnMaxIterations: editSubAgentData.escalationRules?.escalateOnMaxIterations !== false,
        },
      });
    }
  }, [editSubAgentData, editSubAgentId]);

  const updateSubAgentMutation = useMutation<never, Error, { id: string; data: SubAgentFormState }>({
    // AI has been removed platform-wide — sub-agent definitions can no
    // longer be saved. Short-circuit instead of hitting the removed
    // `/ai/agent-definitions` endpoint.
    mutationFn: async () => {
      throw new Error('AI is currently unavailable');
    },
    onError: () => toast.error(tw.failedToUpdateAgent),
  });

  // Close panels on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingStep) setEditingStep(null);
        if (editingBranch) setEditingBranch(null);
        if (showAddActionPanel) setShowAddActionPanel(false);
        if (showTriggerFilterPanel) setShowTriggerFilterPanel(false);
        setShowMobileSidebar(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editingStep, editingBranch, showAddActionPanel, showTriggerFilterPanel]);

  // Auto-show mobile sidebar
  useEffect(() => {
    if (editingStep || editingBranch || showAddActionPanel || showTriggerFilterPanel) {
      setShowMobileSidebar(true);
    }
  }, [editingStep, editingBranch, showAddActionPanel, showTriggerFilterPanel]);

  // Handlers
  const handleSave = async () => {
    try {
      await updateWorkflowMutation.mutateAsync({
        id: workflow.id,
        data: {
          name: workflow.name,
          description: workflow.description,
          triggers: workflow.triggers,
          steps: workflow.steps,
        },
      });
      toast.success(tw.workflowSaved);
    } catch {
      toast.error(tw.failedToSave);
    }
  };

  const handlePublish = async () => {
    await handleSave();
    updateStatusMutation.mutate({ id: workflow.id, status: 'active' }, {
      onSuccess: () => toast.success(tw.workflowPublished),
      onError: (err: Error) => {
        toast.error(err?.message || tw.failedToPublish);
      },
    });
  };

  /** Shared step-creation logic used by both sidebar and inline add */
  const createStep = useCallback((actionType: string, sourceId: string | null | undefined) => {
    const actionNames: Record<string, string> = {};
    helpdeskActionTypes.forEach((a) => { actionNames[a.id] = a.name; });

    const newStep: WorkflowStep = {
      id: `step-${Date.now()}`,
      type: actionType,
      name: actionNames[actionType] || actionType,
      config: {},
      order: workflow.steps.length,
      position: undefined,
    };

    // Pre-configure send_choices with one default button
    if (actionType === 'send_choices') {
      newStep.config = {
        message: '',
        options: [{ label: 'Reply button', value: `btn_${Date.now()}` }],
      };
    }

    // Pre-configure send_notification to reference assigned agent when there's a preceding assign step
    if (actionType === 'send_notification') {
      const precedingAssignStep = workflow.steps.find((s) => s.type === 'assign_conversation');
      if (precedingAssignStep) {
        newStep.config = {
          recipientMode: 'assigned_agent',
          assignStepRef: precedingAssignStep.id,
          userIds: [`{{steps.${precedingAssignStep.id}.assignedUserId}}`],
          category: 'helpdesk',
        };
      }
    }

    // Determine branch membership
    if (sourceId) {
      if (sourceId.includes('_branch_') ||
          sourceId.endsWith('_if') ||
          sourceId.endsWith('_if_not')) {
        newStep.parentBranchId = sourceId;
      } else {
        const sourceStep = workflow.steps.find((s) => s.id === sourceId);
        if (sourceStep?.parentBranchId) {
          newStep.parentBranchId = sourceStep.parentBranchId;
        }
      }
    }

    // If adding a terminal action and one already exists on the same path, replace it
    let updatedSteps = [...workflow.steps];
    const samePathFilter = (s: WorkflowStep) =>
      newStep.parentBranchId
        ? s.parentBranchId === newStep.parentBranchId
        : !s.parentBranchId;
    const existingTerminal = updatedSteps.find((s) =>
      isTerminalAction(s.type) && samePathFilter(s)
    );
    if (isTerminalAction(actionType) && existingTerminal) {
      // Collect the old terminal and all its child branch steps for removal
      const idsToRemove = new Set<string>();
      function collectChildren(stepId: string, stepType: string, stepConfig?: Record<string, unknown>) {
        idsToRemove.add(stepId);
        // For send_choices: remove steps in reply-button branches
        if (stepType === 'send_choices') {
          const opts: Array<{ value?: string }> = Array.isArray(stepConfig?.options) ? (stepConfig!.options as Array<{ value?: string }>) : [];
          opts.forEach((opt, oi) => {
            const branchId = `${stepId}_branch_${opt.value || oi}`;
            updatedSteps.forEach((s) => {
              if (s.parentBranchId === branchId) collectChildren(s.id, s.type, s.config);
            });
          });
        }
        // For ai_auto_reply: remove steps in escalated/resolved branches
        if (stepType === 'ai_auto_reply') {
          ['escalated', 'resolved'].forEach((val) => {
            const branchId = `${stepId}_branch_${val}`;
            updatedSteps.forEach((s) => {
              if (s.parentBranchId === branchId) collectChildren(s.id, s.type, s.config);
            });
          });
        }
        // For conditions: remove steps in condition branches
        if (stepType === 'condition') {
          const branchIds = getConditionBranchIds({ id: stepId, config: stepConfig });
          branchIds.forEach((branchId) => {
            updatedSteps.forEach((s) => {
              if (s.parentBranchId === branchId) collectChildren(s.id, s.type, s.config);
            });
          });
        }
      }
      collectChildren(existingTerminal.id, existingTerminal.type, existingTerminal.config);
      updatedSteps = updatedSteps.filter((s) => !idsToRemove.has(s.id));
    }

    // Insert before any remaining terminal action, or append
    const terminalIdx = updatedSteps.findIndex((s) =>
      isTerminalAction(s.type) && samePathFilter(s)
    );
    if (terminalIdx >= 0 && !isTerminalAction(actionType)) {
      updatedSteps.splice(terminalIdx, 0, newStep);
    } else {
      updatedSteps.push(newStep);
    }

    updatedSteps.forEach((step, i) => (step.order = i));

    setWorkflow({ ...workflow, steps: updatedSteps });
    // Don't open sidebar for actions that are fully inline
    const INLINE_ONLY_ACTIONS = new Set([
      'send_choices',
      'close_conversation',
      'unassign_conversation',
      'wait_for_reply',
      'ai_auto_reply',
    ]);
    if (!INLINE_ONLY_ACTIONS.has(actionType)) {
      setEditingStep(newStep);
    }
    return newStep;
  }, [workflow, helpdeskActionTypes]);

  const handleAddAction = useCallback((actionType: string) => {
    createStep(actionType, addStepSourceNodeId);
    setShowAddActionPanel(false);
    setAddStepSourceNodeId(null);
  }, [createStep, addStepSourceNodeId]);

  /** Inline add — called directly from the flow builder popover */
  const handleAddActionInline = useCallback((actionType: string, sourceNodeId?: string) => {
    createStep(actionType, sourceNodeId);
    setShowAddActionPanel(false);
    setAddStepSourceNodeId(null);
  }, [createStep]);

  const handleUpdateStep = (stepId: string, data: Partial<WorkflowStep>) => {
    setWorkflow({
      ...workflow,
      steps: workflow.steps.map((s) =>
        s.id === stepId ? { ...s, ...data } : s
      ),
    });
    setEditingStep((prev) =>
      prev?.id === stepId ? { ...prev, ...data } : prev
    );
  };

  const handleUpdateConfig = useCallback((stepId: string, config: Record<string, unknown>) => {
    setWorkflow((prev) => ({
      ...prev,
      steps: prev.steps.map((s) =>
        s.id === stepId ? { ...s, config: { ...s.config, ...config } } : s
      ),
    }));
    setEditingStep((prev) =>
      prev?.id === stepId ? { ...prev, config: { ...prev.config, ...config } } : prev
    );
  }, []);

  const handleDeleteStep = useCallback((index: number) => {
    const stepToDelete = workflow.steps[index];
    if (!stepToDelete) return;

    const idsToDelete = new Set<string>();
    function collectDeletions(id: string, type: string, config?: Record<string, unknown>) {
      idsToDelete.add(id);
      if (type === 'condition') {
        const branchIds = getConditionBranchIds({ id, config });
        branchIds.forEach((branchId) => {
          workflow.steps.forEach((s) => {
            if (s.parentBranchId === branchId) {
              collectDeletions(s.id, s.type, s.config);
            }
          });
        });
      }
    }
    collectDeletions(stepToDelete.id, stepToDelete.type, stepToDelete.config);

    const updatedSteps = workflow.steps
      .filter((s) => !idsToDelete.has(s.id))
      .map((step, i) => ({ ...step, order: i }));
    setWorkflow((prev) => ({ ...prev, steps: updatedSteps }));
    setSelectedStepIndex(null);
    setEditingStep(null);
    setEditingBranch(null);
  }, [workflow.steps]);

  // Delete/Backspace to remove the selected step
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedStepIndex !== null && editingStep) {
        e.preventDefault();
        handleDeleteStep(selectedStepIndex);
        setShowMobileSidebar(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedStepIndex, editingStep, handleDeleteStep]);

  // Trigger type is read-only, but filters can be edited
  const handleSelectTrigger = useCallback(() => {
    setShowTriggerFilterPanel(true);
    setShowAddActionPanel(false);
    setEditingStep(null);
    setEditingBranch(null);
    setSelectedStepIndex(null);
  }, []);

  const handleUpdateTriggerConfig = useCallback((configUpdate: TriggerConfigUpdate) => {
    setWorkflow((prev) => {
      const trigger = prev.triggers?.[0];
      if (!trigger) return prev;
      const updatedConfig = {
        ...(trigger.config || {}),
        ...configUpdate,
      };
      // Also keep filters at trigger root for backwards compat
      const updatedTrigger = { ...trigger, config: updatedConfig, filters: configUpdate.filters ?? trigger.filters };
      return { ...prev, triggers: [updatedTrigger] };
    });
  }, []);

  const handleSelectStep = useCallback((index: number) => {
    setSelectedStepIndex(index);
    setShowAddActionPanel(false);
    setShowTriggerFilterPanel(false);
    setEditingBranch(null);
    const step = workflow.steps[index];
    if (step) setEditingStep(step);
  }, [workflow.steps]);

  const handleSelectBranch = useCallback((branchNodeId: string, branchType: string, parentConditionId: string, parentConditionStepIndex: number) => {
    setEditingBranch({ branchNodeId, branchType, parentConditionId, parentConditionStepIndex });
    setEditingStep(null);
    setSelectedStepIndex(null);
    setShowAddActionPanel(false);
    setShowTriggerFilterPanel(false);
  }, []);

  const handleStepsChange = useCallback((updatedSteps: WorkflowStep[]) => {
    setWorkflow((prev) => ({ ...prev, steps: updatedSteps }));
  }, []);

  const handleAddSubAgent = useCallback((stepId: string) => {
    setAddSubAgentForStepId(stepId);
  }, []);

  const handleEditSubAgent = useCallback((subAgentId: string) => {
    setEditSubAgentId(subAgentId);
    setSubAgentForm(null);
  }, []);

  const handleSelectSubAgent = useCallback((agentId: string, agentName: string) => {
    if (!addSubAgentForStepId) return;
    const step = workflow.steps.find((s) => s.id === addSubAgentForStepId);
    if (!step) return;
    const currentIds: string[] = (step.config?.subAgentIds as string[] | undefined) || [];
    const currentNames: Record<string, string> = (step.config?.subAgentNames as Record<string, string> | undefined) || {};
    handleUpdateConfig(addSubAgentForStepId, {
      subAgentIds: [...currentIds, agentId],
      subAgentNames: { ...currentNames, [agentId]: agentName },
    });
    setAddSubAgentForStepId(null);
  }, [addSubAgentForStepId, workflow.steps, handleUpdateConfig]);

  const sortedSteps = [...workflow.steps].sort((a, b) => (a.order || 0) - (b.order || 0));

  return (
    <div className="h-full flex flex-col bg-muted/30 overflow-hidden">
      {/* Header */}
      <div className="bg-background border-b flex-shrink-0 relative z-10">
        <div className="px-2 md:px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 md:gap-2">
              <Link href="/welddesk/workflows">
                <Button variant="outline" size="sm" className="h-8 w-8 p-0">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </Link>
              <div className="relative group">
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "text-xs md:text-sm px-2 md:px-3 border-transparent",
                    !showRunsPanel ? "bg-transparent" : "bg-transparent hover:bg-accent"
                  )}
                  onClick={() => setShowRunsPanel(false)}
                >
                  <GitPullRequest className="h-3 w-3 mr-0.5" />
                  Editor
                </Button>
                <div className={cn(
                  "absolute -bottom-[9px] left-2 right-2 h-0.5 transition-colors",
                  !showRunsPanel ? "bg-foreground" : "bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600"
                )} />
              </div>
              <div className="relative group">
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "text-xs md:text-sm px-2 md:px-3 border-transparent",
                    showRunsPanel ? "bg-transparent" : "bg-transparent hover:bg-accent"
                  )}
                  onClick={() => {
                    setShowRunsPanel(true);
                    setShowTriggerFilterPanel(false);
                    setEditingStep(null);
                    setEditingBranch(null);
                    setShowMobileSidebar(true);
                  }}
                >
                  <History className="h-3 w-3 mr-0.5" />
                  Executions
                </Button>
                <div className={cn(
                  "absolute -bottom-[9px] left-2 right-2 h-0.5 transition-colors",
                  showRunsPanel ? "bg-foreground" : "bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600"
                )} />
              </div>
              <div className="relative group hidden sm:block">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs md:text-sm px-2 md:px-3 border-transparent bg-transparent hover:bg-accent"
                  asChild
                >
                  <Link href={`/welddesk/workflows/${workflow.id}/settings`}>
                    <Settings className="h-3 w-3 mr-0.5" />
                    Settings
                  </Link>
                </Button>
                <div className="absolute -bottom-[9px] left-0 right-0 h-0.5 transition-colors bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600" />
              </div>
            </div>

            <div className="flex items-center gap-1 md:gap-2">
              {/* Mobile sidebar toggle */}
              <Button
                variant="outline"
                size="sm"
                className="lg:hidden h-8 w-8 p-0"
                onClick={() => setShowMobileSidebar(!showMobileSidebar)}
              >
                <Bot className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs md:text-sm px-2 md:px-3"
                onClick={handleSave}
                disabled={isSaving}
              >
                Save
              </Button>
              <Button
                size="sm"
                className="text-xs md:text-sm px-2 md:px-3"
                onClick={handlePublish}
                disabled={isSaving || workflow.steps.length === 0}
              >
                Publish
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Conversation Flow Builder */}
        <div className="flex-1 relative overflow-hidden">
          <ConversationFlowBuilder
            trigger={workflow.triggers[0] || null}
            steps={sortedSteps}
            onSelectTrigger={handleSelectTrigger}
            onSelectStep={handleSelectStep}
            onSelectBranch={handleSelectBranch}
            onDeleteStep={handleDeleteStep}
            onStepsChange={handleStepsChange}
            onAddStep={(sourceNodeId?: string) => {
              setEditingStep(null);
              setEditingBranch(null);
              setShowAddActionPanel(true);
              setShowTriggerFilterPanel(false);
              setAddStepSourceNodeId(sourceNodeId || null);
            }}
            onAddActionInline={handleAddActionInline}
            onUpdateConfig={handleUpdateConfig}
            onAddSubAgent={handleAddSubAgent}
            onEditSubAgent={handleEditSubAgent}
            onDeselect={() => {
              setEditingStep(null);
              setEditingBranch(null);
              setShowAddActionPanel(false);
              setShowTriggerFilterPanel(false);
            }}
            selectedNodeId={showTriggerFilterPanel ? 'trigger' : editingBranch?.branchNodeId || editingStep?.id || null}
            showAddPlaceholder={showAddActionPanel}
            addStepSourceNodeId={addStepSourceNodeId}
            variableItems={canvasVariableItems}
            className="w-full h-full"
          />
        </div>

        {/* Right Sidebar */}
        <div className={cn(
          "bg-background flex flex-col z-50",
          "fixed top-[105px] left-0 right-0 bottom-0 w-full transform transition-transform duration-200",
          "lg:relative lg:top-0 lg:w-[360px] lg:border-l",
          showMobileSidebar ? "translate-y-0" : "translate-y-full lg:translate-y-0 lg:translate-x-0"
        )}>
          {showRunsPanel ? (
            <>
              <div className="pl-4 py-3 pr-3 border-b flex items-center justify-between">
                <h3 className="font-semibold text-sm">{tw.runHistory}</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => { setShowRunsPanel(false); setShowMobileSidebar(false); }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex-1 flex flex-col">
                {/* Empty State */}
                <div className="flex-1 flex flex-col items-center justify-center px-4">
                  <div className="relative mb-4 scale-75">
                    <div className="relative py-4">
                      <div className="flex gap-3 mb-3">
                        <div className="w-14 h-10 border border-dashed border-red-200 rounded-lg" />
                        <div className="w-24 h-10 border border-dashed border-red-200 rounded-lg" />
                      </div>
                      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full border-2 border-red-200 bg-background flex items-center justify-center z-10">
                        <XCircle className="w-5 h-5 text-red-400" />
                      </div>
                      <div className="flex gap-3">
                        <div className="w-20 h-10 border border-dashed border-red-200 rounded-lg" />
                        <div className="w-16 h-10 border border-dashed border-red-200 rounded-lg" />
                      </div>
                    </div>
                  </div>
                  <h4 className="text-base font-semibold mb-1">{tw.noRuns}</h4>
                  <p className="text-sm text-muted-foreground text-center">
                    {tw.noRunsDesc}
                  </p>
                </div>

                {/* Overview Stats */}
                <div className="p-4 border-t">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 rounded-lg bg-green-50 border border-green-100">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-lg font-semibold text-green-700">0</span>
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      </div>
                      <p className="text-xs text-green-600">{tw.runCompleted}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-red-50 border border-red-100">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-lg font-semibold text-red-700">0</span>
                        <XCircle className="w-4 h-4 text-red-500" />
                      </div>
                      <p className="text-xs text-red-600">{tw.runFailed}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/50 border border-border">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-lg font-semibold">0</span>
                        <RefreshCw className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <p className="text-xs text-muted-foreground">{tw.runInProgress}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/50 border border-border">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-lg font-semibold">-</span>
                        <Clock className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <p className="text-xs text-muted-foreground">{tw.runAvgRuntime}</p>
                    </div>
                  </div>
                  <div className="mt-2 p-3 rounded-lg bg-muted/50 border border-border">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-lg font-semibold">0</span>
                      <Settings className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <p className="text-xs text-muted-foreground">{tw.creditsConsumed.replace('{consumed}', '0').replace('{included}', '250')}</p>
                  </div>
                </div>
              </div>
            </>
          ) : showTriggerFilterPanel ? (
            <TriggerFilterPanel
              workflow={workflow}
              onUpdateTriggerConfig={handleUpdateTriggerConfig}
              onClose={() => { setShowTriggerFilterPanel(false); setShowMobileSidebar(false); }}
            />
          ) : showAddActionPanel ? (
            <AddActionPanel
              trigger={workflow.triggers[0]}
              onAddAction={handleAddAction}
              onClose={() => { setShowAddActionPanel(false); setShowMobileSidebar(false); }}
            />
          ) : editingBranch ? (
            <BranchEditPanel
              editingBranch={editingBranch}
              workflow={workflow}
              onSelectStep={handleSelectStep}
              onAddStepToBranch={(branchNodeId) => {
                setEditingBranch(null);
                setShowAddActionPanel(true);
                setAddStepSourceNodeId(branchNodeId);
              }}
              onClose={() => { setEditingBranch(null); setShowMobileSidebar(false); }}
            />
          ) : editingStep ? (
            <StepEditPanel
              editingStep={editingStep}
              workflow={workflow}
              workspaceMembers={workspaceMembers}
              workflowVariables={workflowVariables}
              onUpdateStep={handleUpdateStep}
              onDeleteStep={(index) => {
                handleDeleteStep(index);
                setEditingStep(null);
              }}
              onClose={() => { setEditingStep(null); setShowMobileSidebar(false); }}
            />
          ) : (
            <OverviewPanel
              workflow={workflow}
              savedAgents={savedAgents}
              onSelectTrigger={handleSelectTrigger}
              onSelectStep={handleSelectStep}
              onCloseMobile={() => setShowMobileSidebar(false)}
            />
          )}
        </div>
      </div>

      {/* Sub-Agent Picker Dialog */}
      <SubAgentPickerDialog
        open={!!addSubAgentForStepId}
        onOpenChange={(open) => { if (!open) setAddSubAgentForStepId(null); }}
        workflow={workflow}
        stepId={addSubAgentForStepId}
        savedAgents={savedAgents}
        onSelectAgent={handleSelectSubAgent}
      />

      {/* Edit Sub-Agent Dialog */}
      <SubAgentEditDialog
        editSubAgentId={editSubAgentId}
        subAgentForm={subAgentForm}
        setSubAgentForm={setSubAgentForm}
        mcpConnections={mcpConnections}
        onClose={() => { setEditSubAgentId(null); setSubAgentForm(null); }}
        onSave={() => {
          if (!editSubAgentId || !subAgentForm) return;
          updateSubAgentMutation.mutate({ id: editSubAgentId, data: subAgentForm });
        }}
        isSaving={updateSubAgentMutation.isPending}
      />
    </div>
  );
}
