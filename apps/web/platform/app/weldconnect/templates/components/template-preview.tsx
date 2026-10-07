import { useEffect, useMemo } from 'react';
import { ReactFlow, Background, BackgroundVariant, useReactFlow, Panel } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Maximize, Minus, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  TriggerNode,
  ActionNode,
  PlaceholderNode,
  ConditionNode,
  ConditionBranchNode,
  workflowToFlow,
} from '@weldsuite/ui/components/workflow-canvas';
import type { WorkflowStep, TriggerConfig } from '@weldsuite/ui/components/workflow-canvas';
import type { TemplateStep, TemplateTrigger } from '@weldsuite/app-api-client/schemas/weldconnect-templates';

// Same node types as the real editor, read-only.
const previewNodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
  condition: ConditionNode,
  condition_branch: ConditionBranchNode,
  placeholder: PlaceholderNode,
};

/**
 * A template's first trigger and its steps in the canvas's shape: templates
 * store triggers flat (settings next to `type`, like the editor saves them),
 * the canvas reads them from `config`.
 */
export function templateToFlowData(
  triggers: readonly TemplateTrigger[],
  steps: readonly TemplateStep[],
): { trigger: TriggerConfig | null; steps: WorkflowStep[] } {
  const first = triggers[0];
  let trigger: TriggerConfig | null = null;
  if (first) {
    const { id, type, name, isEnabled, config, ...flat } = first;
    trigger = {
      id,
      type: type as TriggerConfig['type'],
      name: typeof name === 'string' ? name : type,
      isEnabled: isEnabled !== false,
      config: { type, ...flat, ...((config as Record<string, unknown> | undefined) ?? {}) },
    };
  }
  return {
    trigger,
    steps: steps.map((step) => ({
      id: step.id,
      type: step.type,
      name: step.name,
      config: step.config ?? {},
      inputs: {},
      order: step.order,
      ...(step.parentBranchId ? { parentBranchId: step.parentBranchId } : {}),
    })),
  };
}

function PreviewControls() {
  const t = useTranslations();
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn({ duration: 150 });
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOut({ duration: 150 });
      } else if (e.key === '0') {
        e.preventDefault();
        fitView({ padding: 0.15, duration: 200 });
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [zoomIn, zoomOut, fitView]);

  const buttonClass = 'w-8 h-8 flex items-center justify-center hover:bg-muted transition-colors p-0 rounded-none';
  return (
    <Panel position="bottom-right" className="!m-3">
      <div className="flex flex-col bg-background border border-border rounded-lg overflow-hidden">
        <Button variant="ghost" onClick={() => zoomIn({ duration: 150 })} className={buttonClass} title={t('sweep.weldconnect.templatePreview.zoomIn')}>
          <Plus className="w-3.5 h-3.5 text-foreground" />
        </Button>
        <div className="border-t border-border" />
        <Button variant="ghost" onClick={() => zoomOut({ duration: 150 })} className={buttonClass} title={t('sweep.weldconnect.templatePreview.zoomOut')}>
          <Minus className="w-3.5 h-3.5 text-foreground" />
        </Button>
        <div className="border-t border-border" />
        <Button
          variant="ghost"
          onClick={() => fitView({ padding: 0.15, duration: 200 })}
          className={buttonClass}
          title={t('sweep.weldconnect.templatePreview.fitView')}
        >
          <Maximize className="w-3.5 h-3.5 text-foreground" />
        </Button>
      </div>
    </Panel>
  );
}

/** A template drawn on the editor's canvas, read-only (pan and zoom only). */
export function TemplatePreview({
  triggers,
  steps,
}: Readonly<{ triggers: readonly TemplateTrigger[]; steps: readonly TemplateStep[] }>) {
  const flow = useMemo(() => templateToFlowData(triggers, steps), [triggers, steps]);
  const { nodes: rawNodes, edges: rawEdges } = useMemo(() => workflowToFlow(flow.trigger, flow.steps), [flow]);

  const nodes = useMemo(
    () =>
      rawNodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          onSelect: undefined,
          onDelete: undefined,
          onAddStep: undefined,
          onUpdateConfig: undefined,
          onSelectBranch: undefined,
          showAddPlaceholder: false,
          isLastNode: false,
        },
        draggable: false,
        selectable: false,
        connectable: false,
      })),
    [rawNodes],
  );
  const edges = useMemo(() => rawEdges.map((edge) => ({ ...edge, selectable: false, focusable: false })), [rawEdges]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        defaultNodes={nodes}
        defaultEdges={edges}
        nodeTypes={previewNodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 0.85 }}
        minZoom={0.2}
        maxZoom={1.5}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background id="template-preview" variant={BackgroundVariant.Dots} gap={20} size={1} bgColor="hsl(var(--muted) / 0.3)" />
        <PreviewControls />
      </ReactFlow>
    </div>
  );
}
