
import React, { useState, useCallback, useMemo } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Save,
  ChevronLeft,
  Zap,
  Mail,
  Globe,
  Clock,
  Code,
  FileText,
  GitBranch,
  Plus,
  Pencil,
  Search,
  Bell,
  Sparkles,
  FileSearch,
  Variable,
  Wand2,
  Repeat,
  Trash2,
} from 'lucide-react';
import { Link } from '@/lib/router';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useUpdateTemplate } from '@/hooks/queries/use-automation-queries';
import { ActionConfigForm } from '@/components/workflow-editor/components/action-config-form';
import { WorkflowCanvas, type WorkflowStep, type TriggerConfig } from '@weldsuite/ui/components/workflow-canvas';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';

// Templates persist loosely-typed trigger/step JSON (backend declares them as
// `unknown[]`); these describe the raw shape before normalization below fills
// in the fields WorkflowCanvas's stricter contract requires.
export interface RawTemplateStep {
  id?: string;
  type: string;
  name: string;
  config?: Record<string, unknown>;
  parentBranchId?: string;
  [key: string]: unknown;
}

export interface RawTemplateTrigger {
  type: string;
  [key: string]: unknown;
}

interface TemplateEditorClientProps {
  template: {
    id: string;
    name: string;
    description?: string | null;
    category?: string | null;
    triggers?: RawTemplateTrigger[];
    steps?: RawTemplateStep[];
    workflow?: { steps?: RawTemplateStep[] };
  };
  emailAccounts?: Array<{ id: string; email: string; displayName?: string }>;
  workspaceMembers?: Array<{ id: string; name: string; email: string; avatar?: string }>;
}

// Sidebar action types
interface SidebarActionType {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType;
  category: 'communication' | 'data' | 'logic' | 'integration' | 'ai';
}

// Static icon/category metadata — names resolved from i18n at runtime
const SIDEBAR_ACTION_META: Array<{ id: string; icon: React.ElementType; category: 'communication' | 'data' | 'logic' | 'integration' | 'ai' }> = [
  { id: 'send_email', icon: Mail, category: 'communication' },
  { id: 'send_notification', icon: Bell, category: 'communication' },
  { id: 'create_record', icon: Plus, category: 'data' },
  { id: 'update_record', icon: Pencil, category: 'data' },
  { id: 'delete_record', icon: Trash2, category: 'data' },
  { id: 'query_data', icon: Search, category: 'data' },
  { id: 'set_variable', icon: Variable, category: 'data' },
  { id: 'transform_data', icon: Wand2, category: 'data' },
  { id: 'condition', icon: GitBranch, category: 'logic' },
  { id: 'loop', icon: Repeat, category: 'logic' },
  { id: 'delay', icon: Clock, category: 'logic' },
  { id: 'http_request', icon: Globe, category: 'integration' },
  { id: 'run_script', icon: Code, category: 'integration' },
  { id: 'ai_generate', icon: Sparkles, category: 'ai' },
  { id: 'ai_extract', icon: FileSearch, category: 'ai' },
  { id: 'ai_summarize', icon: FileText, category: 'ai' },
];

export function TemplateEditorClient({
  template: initialTemplate,
  emailAccounts = [],
  workspaceMembers = [],
}: TemplateEditorClientProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.templateEditorClient;

  // Build translated action types
  const sidebarActionTypes: SidebarActionType[] = useMemo(() => {
    const actions = t.weldconnect.addNodePanel.actions as Record<string, { name: string; description: string }>;
    return SIDEBAR_ACTION_META.map((a) => ({
      ...a,
      name: actions[a.id]?.name ?? a.id,
      description: actions[a.id]?.description ?? '',
    }));
  }, [t]);

  // Build translated category labels
  const categoryLabels = useMemo(
    () => t.weldconnect.addNodePanel.categories as Record<string, string>,
    [t]
  );

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.task, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.templates, href: '/weldconnect/templates' },
    { label: initialTemplate.name },
  ]);

  // Convert template to workflow-like structure for editing, filling in the
  // fields WorkflowCanvas's stricter contract requires but templates don't
  // always persist (id, isEnabled, inputs).
  const [template, setTemplate] = useState(() => {
    const rawTriggers = initialTemplate.triggers ?? [];
    const rawSteps = initialTemplate.steps ?? initialTemplate.workflow?.steps ?? [];
    return {
      ...initialTemplate,
      triggers: rawTriggers.map((trig): TriggerConfig => ({
        ...trig,
        id: typeof trig.id === 'string' ? trig.id : 'trigger',
        type: trig.type as TriggerConfig['type'],
        name: typeof trig.name === 'string' ? trig.name : trig.type,
        isEnabled: typeof trig.isEnabled === 'boolean' ? trig.isEnabled : true,
        config: (trig.config as Record<string, unknown> | undefined) ?? {},
      })),
      steps: rawSteps.map((step, index): WorkflowStep => ({
        ...step,
        id: step.id ?? `step-${index}`,
        config: step.config ?? {},
        inputs: {},
      })),
    };
  });

  const updateTemplateMutation = useUpdateTemplate();
  const isSaving = updateTemplateMutation.isPending;
  const [editingStep, setEditingStep] = useState<WorkflowStep | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);
  const [showAddActionPanel, setShowAddActionPanel] = useState(false);
  const [addStepSourceNodeId, setAddStepSourceNodeId] = useState<string | null>(null);

  // Handle save
  const handleSave = () => {
    updateTemplateMutation.mutate({
      id: template.id,
      data: {
        name: template.name,
        description: template.description ?? undefined,
        category: template.category ?? undefined,
        triggers: template.triggers,
        steps: template.steps,
      },
    }, {
      onSuccess: () => {
        toast.success(tec.toasts.saved);
      },
      onError: () => {
        toast.error(tec.toasts.saveFailed);
      },
    });
  };

  // Handle step selection from flow editor
  const handleStepSelect = useCallback((step: WorkflowStep, index: number) => {
    setEditingStep(step);
    setSelectedStepIndex(index);
    setShowAddActionPanel(false);
  }, []);

  // Handle step config update
  const handleStepConfigChange = useCallback((config: Record<string, unknown>) => {
    if (selectedStepIndex === null || !editingStep) return;

    const updatedSteps = [...template.steps];
    updatedSteps[selectedStepIndex] = {
      ...updatedSteps[selectedStepIndex],
      config,
    };

    setTemplate({ ...template, steps: updatedSteps });
    setEditingStep({ ...editingStep, config });
  }, [selectedStepIndex, editingStep, template]);

  // Handle step name change
  const handleStepNameChange = useCallback((name: string) => {
    if (selectedStepIndex === null || !editingStep) return;

    const updatedSteps = [...template.steps];
    updatedSteps[selectedStepIndex] = {
      ...updatedSteps[selectedStepIndex],
      name,
    };

    setTemplate({ ...template, steps: updatedSteps });
    setEditingStep({ ...editingStep, name });
  }, [selectedStepIndex, editingStep, template]);

  // Handle step delete
  const handleDeleteStep = useCallback(() => {
    if (selectedStepIndex === null) return;

    const updatedSteps = template.steps.filter((_: WorkflowStep, i: number) => i !== selectedStepIndex);
    setTemplate({ ...template, steps: updatedSteps });
    setEditingStep(null);
    setSelectedStepIndex(null);
  }, [selectedStepIndex, template]);

  // Handle adding a new step
  const handleAddStep = useCallback((actionType: string) => {
    const newStep: WorkflowStep = {
      id: `step_${Date.now()}`,
      name: sidebarActionTypes.find(a => a.id === actionType)?.name || actionType,
      type: actionType,
      config: {},
      inputs: {},
    };

    let insertIndex = template.steps.length;

    // If adding from a specific node, insert after that node
    if (addStepSourceNodeId) {
      const sourceIndex = template.steps.findIndex((s: WorkflowStep) => s.id === addStepSourceNodeId);
      if (sourceIndex !== -1) {
        insertIndex = sourceIndex + 1;
      }
    }

    const updatedSteps = [...template.steps];
    updatedSteps.splice(insertIndex, 0, newStep);

    setTemplate({ ...template, steps: updatedSteps });
    setShowAddActionPanel(false);
    setAddStepSourceNodeId(null);

    // Select the new step
    setEditingStep(newStep);
    setSelectedStepIndex(insertIndex);
  }, [template, addStepSourceNodeId, sidebarActionTypes]);

  // Handle steps reorder from flow editor
  const handleStepsChange = useCallback((newSteps: WorkflowStep[]) => {
    setTemplate({ ...template, steps: newSteps });
  }, [template]);

  // Handle request to show add panel
  const handleShowAddPanel = useCallback((sourceNodeId?: string) => {
    setAddStepSourceNodeId(sourceNodeId || null);
    setShowAddActionPanel(true);
    setEditingStep(null);
    setSelectedStepIndex(null);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-white dark:bg-background">
        <div className="flex items-center gap-3">
          <Link href="/weldconnect/templates">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-semibold">{template.name}</h1>
              <Badge variant="outline" className="text-xs">{tec.templateBadge}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{template.description || tec.noDescription}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={isSaving}
            className="h-8"
          >
            <Save className="h-4 w-4 mr-1.5" />
            {isSaving ? tec.saving : tec.save}
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Flow Editor */}
        <div className="flex-1 relative">
          <WorkflowCanvas
            trigger={template.triggers?.[0] ?? null}
            steps={template.steps ?? []}
            selectedNodeId={editingStep?.id ?? null}
            onSelectTrigger={() => {}}
            onSelectStep={(index) => handleStepSelect(template.steps[index], index)}
            onDeleteStep={(index) => handleStepsChange(template.steps.filter((_: unknown, i: number) => i !== index))}
            onStepsChange={handleStepsChange}
            onAddStep={handleShowAddPanel}
          />
        </div>

        {/* Right Panel - Step Config or Add Action */}
        <div className="w-[400px] border-l bg-white dark:bg-background flex flex-col">
          {showAddActionPanel ? (
            <>
              <div className="p-4 border-b">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">{tec.addStep}</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAddActionPanel(false)}
                  >
                    {tec.cancel}
                  </Button>
                </div>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-4 space-y-4">
                  {Object.entries(categoryLabels).map(([category, label]) => {
                    const actions = sidebarActionTypes.filter(a => a.category === category);
                    if (actions.length === 0) return null;

                    return (
                      <div key={category}>
                        <h3 className="text-xs font-medium text-muted-foreground mb-2">{label}</h3>
                        <div className="space-y-1">
                          {actions.map(action => (
                            <Button
                              key={action.id}
                              variant="ghost"
                              onClick={() => handleAddStep(action.id)}
                              className="w-full flex items-center gap-3 p-2 rounded-md hover:bg-gray-100 dark:hover:bg-secondary text-left"
                            >
                              <div className="p-1.5 rounded bg-gray-100 dark:bg-secondary">
                                <action.icon className="h-4 w-4" />
                              </div>
                              <div>
                                <div className="text-sm font-medium">{action.name}</div>
                                <div className="text-xs text-muted-foreground">{action.description}</div>
                              </div>
                            </Button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </>
          ) : editingStep ? (
            <>
              <div className="p-4 border-b">
                <div className="flex items-center justify-between">
                  <div>
                    <Input
                      value={editingStep.name}
                      onChange={(e) => handleStepNameChange(e.target.value)}
                      className="font-semibold h-8 px-2 -ml-2"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {tec.stepType.replace('{type}', editingStep.type)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                    onClick={handleDeleteStep}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-4">
                  <ActionConfigForm
                    actionType={editingStep.type}
                    config={editingStep.config || {}}
                    onChange={handleStepConfigChange}
                    emailAccounts={emailAccounts}
                    workspaceMembers={workspaceMembers}
                    workflowSteps={template.steps}
                    currentStepIndex={selectedStepIndex ?? 0}
                  />
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center p-8">
              <div>
                <Zap className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                <p className="text-muted-foreground">
                  {tec.selectStep}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
