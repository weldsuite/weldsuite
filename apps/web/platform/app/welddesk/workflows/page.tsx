import { useState, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import { useHelpdeskWorkflows, useHelpdeskWorkflowStats, useCreateWorkflow, type Workflow } from '@/hooks/queries/use-automation-queries';
import { WorkflowsClient } from '@/app/weldconnect/workflows/components/workflows-client';
import { WorkflowTemplatesDialog } from '@/app/welddesk/workflows/components/workflow-templates-dialog';
import { HELPDESK_ROUTING_TRIGGERS, TRIGGER_CATEGORIES } from '@/app/welddesk/workflows/[id]/edit/helpdesk-workflow-constants';
import type { WorkflowStep, WorkflowTrigger } from '@/app/welddesk/workflows/[id]/edit/types';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { ConfirmDialog } from '@/components/confirm-dialog';

/**
 * `/helpdesk-workflows` also returns a display `sortOrder`, which the
 * `Workflow` type (shared with WeldConnect workflows) doesn't model.
 */
type HelpdeskWorkflowRow = Workflow & { sortOrder?: number };

/** Row shape handed to the shared `WorkflowsClient` list component. */
interface MappedWorkflow {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'paused' | 'draft' | 'archived';
  triggerType: string;
  stepsCount: number;
  executionCount: number;
  successRate: number | undefined;
  lastExecutedAt: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
  sortOrder: number;
}

/**
 * Resolve the trigger key from a workflow's trigger config.
 * Returns a composite key like "helpdesk_conversation_message:created".
 */
function getTriggerKey(workflow: HelpdeskWorkflowRow): string {
  const trigger = workflow.triggers?.[0] as WorkflowTrigger | undefined;
  if (!trigger) return 'unconfigured';
  const config = trigger.config as { entityType?: string; eventType?: string } | undefined;
  const entityType = trigger.entityType || config?.entityType || '';
  const eventType = trigger.eventType || config?.eventType || '';
  if (!entityType || !eventType) return 'unconfigured';
  return `${entityType}:${eventType}`;
}

/**
 * Resolve a human-readable trigger label from a trigger key.
 * NOTE: 'unconfigured' case is handled with the locale key in the component.
 */
function getTriggerLabel(key: string): string {
  if (key === 'unconfigured') return key;
  const [entityType, eventType] = key.split(':');
  const match = HELPDESK_ROUTING_TRIGGERS.find(
    (t) => t.entityType === entityType && t.eventType === eventType,
  );
  return match?.label ?? key;
}

export default function HelpdeskAutomationsPage() {
  const { t } = useI18n();
  const tw = t.helpdesk.workflowsPage;
  const twc = t.helpdesk.workflowsConfirm;
  const [showTemplates, setShowTemplates] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const navigate = useNavigate();
  const { getClient } = useAppApiClient();
  const { data: workflowsResult, isLoading: isWorkflowsLoading, refetch: refetchWorkflows } = useHelpdeskWorkflows();
  const { data: statsResult, isLoading: isStatsLoading } = useHelpdeskWorkflowStats();
  const createMutation = useCreateWorkflow('/helpdesk-workflows');

  const handleSeedDefaults = async () => {
    setIsResetting(true);
    try {
      const client = await getClient();
      const result = await client.post<{ data: { seeded: number } }>('/helpdesk-workflows/seed-defaults', {});
      const data = result.data;
      if (data?.seeded > 0) {
        toast.success(tw.seededDefaultWorkflows.replace('{count}', String(data.seeded)));
      } else {
        toast.info(tw.allDefaultWorkflowsExist);
      }
      refetchWorkflows();
    } catch {
      toast.error(tw.failedToSeedDefaultWorkflows);
    } finally {
      setIsResetting(false);
    }
  };

  const handleResetDefaults = async () => {
    setShowResetConfirm(false);
    setIsResetting(true);
    try {
      const client = await getClient();
      const result = await client.post<{ data: { deleted: number; created: number } }>('/helpdesk-workflows/reset-defaults', {});
      const data = result.data;
      toast.success(tw.resetDefaultWorkflowsComplete.replace('{deleted}', String(data?.deleted ?? 0)).replace('{created}', String(data?.created ?? 0)));
      refetchWorkflows();
    } catch {
      toast.error(tw.failedToResetDefaultWorkflows);
    } finally {
      setIsResetting(false);
    }
  };

  const workflows = useMemo(() => (workflowsResult?.data ?? []) as HelpdeskWorkflowRow[], [workflowsResult?.data]);
  const stats = statsResult?.data;

  // Map workflows to client format, using the composite trigger key as triggerType
  // so the shared WorkflowsClient can display it and the group configs can filter on it.
  // Sort by sortOrder so workflows within each trigger group show in execution order
  const mappedWorkflows = useMemo<MappedWorkflow[]>(() => workflows
    .map((w): MappedWorkflow => ({
      id: w.id,
      name: w.name,
      description: w.description,
      status: w.status as 'active' | 'paused' | 'draft' | 'archived',
      triggerType: getTriggerKey(w),
      stepsCount: w.steps?.length || 0,
      executionCount: w.executionCount || 0,
      successRate: w.executionCount && w.successCount
        ? (w.successCount / w.executionCount) * 100
        : undefined,
      lastExecutedAt: w.lastExecutedAt as unknown as Date | null,
      createdAt: w.createdAt as unknown as Date,
      updatedAt: w.updatedAt as unknown as Date | null,
      sortOrder: w.sortOrder ?? 0,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder),
  [workflows]);

  // Build group configs: one group per trigger, ordered by HELPDESK_ROUTING_TRIGGERS,
  // with unconfigured workflows shown last.
  const triggerGroups = useMemo(() => {
    const keysInData = new Set(mappedWorkflows.map((w) => w.triggerType));
    const groups: Array<{ id: string; label: string; sortOrder: number; filter: (w: { triggerType?: string }) => boolean }> = [];
    let sortOrder = 1;

    for (const rt of HELPDESK_ROUTING_TRIGGERS) {
      const key = `${rt.entityType}:${rt.eventType}`;
      if (keysInData.has(key)) {
        groups.push({
          id: key,
          label: rt.label,
          sortOrder: sortOrder++,
          filter: (w) => w.triggerType === key,
        });
      }
    }

    if (keysInData.has('unconfigured')) {
      groups.push({
        id: 'unconfigured',
        label: twc.noTrigger,
        sortOrder: sortOrder++,
        filter: (w) => w.triggerType === 'unconfigured',
      });
    }

    return groups;
  }, [mappedWorkflows, twc.noTrigger]);

  // Build filter options from the triggers present in the data
  const triggerFilterOptions = useMemo(() => {
    const keysInData = new Set(mappedWorkflows.map((w) => w.triggerType));
    const options: Array<{ value: string; label: string }> = [];
    for (const rt of HELPDESK_ROUTING_TRIGGERS) {
      const key = `${rt.entityType}:${rt.eventType}`;
      if (keysInData.has(key)) {
        options.push({ value: key, label: rt.label });
      }
    }
    if (keysInData.has('unconfigured')) {
      options.push({ value: 'unconfigured', label: twc.noTriggerLabel });
    }
    return options;
  }, [mappedWorkflows, twc.noTriggerLabel]);

  // No restriction on duplicate triggers — multiple workflows can share the same
  // trigger type and will execute in sortOrder (like Intercom).

  // Trigger options for the create dialog
  const createTriggerOptions = useMemo(() =>
    HELPDESK_ROUTING_TRIGGERS.map((rt) => ({
      id: rt.id,
      label: rt.label,
      description: rt.description,
      icon: rt.icon,
      entityType: rt.entityType,
      eventType: rt.eventType,
      category: rt.category,
    })),
  []);

  if (isWorkflowsLoading || isStatsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  // Calculate stats
  const initialStats = {
    active: workflows.filter((w) => w.status === 'active').length,
    paused: workflows.filter((w) => w.status === 'paused').length,
    draft: workflows.filter((w) => w.status === 'draft').length,
    totalExecutions: stats?.totalExecutions || 0,
  };

  const handleCreateFromTemplate = (template: { name: string; description: string; triggers: WorkflowTrigger[]; steps: WorkflowStep[] }) => {
    setShowTemplates(false);
    createMutation.mutate(
      {
        name: template.name,
        description: template.description,
        status: 'draft',
        triggers: template.triggers,
        steps: template.steps,
      },
      {
        onSuccess: (result) => {
          toast.success(tw.workflowCreatedFromTemplate.replace('{name}', template.name));
          refetchWorkflows();
          const id = result?.data?.id;
          if (id) {
            navigate({ to: '/welddesk/workflows/$id/edit', params: { id } });
          }
        },
        onError: () => {
          toast.error(tw.failedToCreateWorkflowFromTemplate);
        },
      },
    );
  };

  return (
    <>
      <WorkflowsClient
        initialWorkflows={mappedWorkflows}
        initialStats={initialStats}
        category="workflow"
        basePath="/welddesk/workflows"
        apiBasePath="/helpdesk-workflows"
        entityLabel={tw.entityLabel}
        entityLabelPlural={tw.entityLabelPlural}
        parentLabel={tw.parentLabel}
        parentHref="/welddesk"
        showTemplatesButton={false}
        showResetDefaults
        onSeedDefaults={handleSeedDefaults}
        onResetDefaults={() => setShowResetConfirm(true)}
        isResetting={isResetting}
        onNewFromTemplate={() => setShowTemplates(true)}
        triggerGroups={triggerGroups}
        triggerFilterOptions={triggerFilterOptions}
        triggerLabelFn={getTriggerLabel}
        createTriggerOptions={createTriggerOptions}
        createTriggerCategories={TRIGGER_CATEGORIES}
      />
      <WorkflowTemplatesDialog
        open={showTemplates}
        onOpenChange={setShowTemplates}
        onSelect={handleCreateFromTemplate}
      />
      <ConfirmDialog
        open={showResetConfirm}
        onOpenChange={setShowResetConfirm}
        title={twc.resetTitle}
        description={twc.resetDescription}
        confirmLabel={twc.resetConfirmText}
        variant="destructive"
        onConfirm={handleResetDefaults}
      />
    </>
  );
}
